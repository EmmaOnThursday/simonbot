var client = require('./client');
var config = require('../config');
var c = require('../common');
var _ = require('lodash');
var buildkite = require('../buildkite/buildkite');
var pullrequest = require('../pullrequest/pullrequest');

exports.getUsername = async () => {
    query = `
        query {
            viewer {
                login
                name
            }
        }
    `;

    return (await client.query(query)).body.data.viewer.login;
};

const mergePullRequest = async pr => {
    console.log('attempting merge on ', pr.title);
    const mutation = `
        mutation {
            mergePullRequest(input: {
                pullRequestId: ${pr.id}
            }) {
                pullRequest {
                    title
                    merged
                    closed
                }
            }
        }
    `;

    // worst case if this doesn't work, we'll drop to v3 api.
    // https://developer.github.com/v3/pulls/#merge-a-pull-request-merge-button

    try {
        // return await client.mutate(mutation);

        // RIP need to be a github app to run this. Maybe need to upgrade.
        const uri = `/repos/${config.secrets.repoowner}/${config.secrets.repo}/pulls/${pr.number}/merge`;
        console.log(uri);
        return await client.v3request({
            method: 'POST',
            uri,
            data: {
                merge_method: 'rebase',
            },
        });
    } catch (err) {
        console.log(err);
    }
};

// lol github doesn't like it if you just request the world.
// they have some checks. 100 comments max which is what we're actually
// worried abotu blowing. PRs 40 would probably be sufficient but whatever.
// if you're active in non-samsara repositories, then this might fail for you. :shrug:
// there's just no way I'm dealing with pagination for the time being.
const maxNodes = 100;

// if pullReqs is passed in, this is the identity function.
// useful in case they're being passed around.
const getPrs = async pullReqs => {
    if (pullReqs) {
        return pullReqs;
    }

    // query for open PRs by the viewer (access token based)
    const query = `
        query { 
            viewer { 
                login 
                name 
                pullRequests(last: ${30}, states:OPEN) {
                    nodes {
                        comments(last: ${maxNodes}) {
                            nodes {
                                author {
                                    login
                                }
                                body
                                createdAt
                                id
                            }
                        }
                        createdAt
                        updatedAt
                        body
                        title
                        number
                        id
                        mergeable
                        mergeStateStatus
                        # canBeRebased
                        headRef {
                            name
                            target {
                                oid
                            }
                        }
                        # base branch so that rebasing can be done properly onto that.
                        baseRef {
                            name
                            target {
                                oid
                            }
                        }
                        headRepository {
                            url
                        }
                        # uh, don't have more than 100 commits? (github has max 250 on this lmao)
                        commits(last: 80) {
                            nodes {
                                commit {
                                    oid
                                    commitUrl
                                    message
                                    # status will be pending since reviewer count is there. 
                                    # probably use checkSuites
                                    status {
                                        state
                                    }
                                }
                            }
                        }
                    }
                }
            } 
        }
    `;

    const resp = await client.query(query);
    return resp.body.data.viewer.pullRequests.nodes;
};

// prs that are open that are in the repo the app is configured for.
// if you don't pass in pullReqs, they'll be queried from github.
const getOpenPrs = async pullReqs => {
    return (await getPrs(pullReqs)).filter(pr => config.gitrepourl.includes(pr.headRepository.url));
};

// shoot me. Github api v4 doesn't have statuses yet -______-. So let's go to v3 and get them.
const getRefStatuses = async sha => {
    return await client.v3request({
        uri: `/repos/${config.secrets.repoowner}/${config.secrets.repo}/commits/${sha}/statuses`,
    });
};

const hasFailingStatus = async pr => {
    // TODO let's cache the statuses on the PR here? and if it's there, just use that. yay mutatbility.

    const isFailed = t => t === 'failure';
    // we actually want the last commit with statuses. sometimes the last commit won't trigger ci.
    // why? deps detection? I'm not actually sure.
    let statuses = null;
    for (let commit of pullrequest.getCommits(pr)) {
        const list = (await getRefStatuses(commit.oid)).body;
        if (c.notEmpty(list)) {
            statuses = list;
            break;
        }
    }
    return statuses.map(s => s.state).some(isFailed);
};

// github changed recently to actually store more of these as unicode emojis rather
// than the `:...:` format. so let's support both. sigh
const shippedEmojis = [':shipit:', ':sheep:', '🐑'];
const updateMeEmojis = [':fire_engine:', '🚒', ':man_health_worker:', '👨‍⚕'];

const textTriggersEmojiSet = emojiSet => text => emojiSet.some(e => text.includes(e));

const textTriggersShippit = textTriggersEmojiSet(shippedEmojis);
const textTriggersUpdate = textTriggersEmojiSet(updateMeEmojis);

const prsToTriggered = async (textFilter, pullReqs) => {
    const prs = (await getOpenPrs(pullReqs)).filter(pr => {
        return textFilter(pr.body) || pr.comments.nodes.map(c => c.body).some(textFilter);
    });
    return prs;
};

// a pr is shipped if one of the emojis present in any of the comments.
// if you don't pass in pullReqs, they'll be queried from github.
const getShippedPrs = async pullReqs => prsToTriggered(textTriggersShippit, pullReqs);
const getUpdatePrs = async pullReqs => prsToTriggered(textTriggersUpdate, pullReqs);

// get prs which have a triggering emoji which aren't passing ci. We want to rebase those.
const getPrsToFixup = async pullReqs => {
    const pulls = await getOpenPrs(pullReqs);
    // we want to rebase if the last commit has any failing status.
    // pending statuses are ok because some statuses don't resolve until approvals happen.

    // dedupe by id in case a pr is both shipped and fixuped
    const prs = _.uniqBy([...(await getShippedPrs(pulls)), ...(await getUpdatePrs(pulls))], pr => pr.id);
    const failingPrs = await prs.filterAsync(hasFailingStatus);

    // we want to split out ones that are failing generically vs due to gitdiff.
    // so we annotate each pr with the reason it failed.
    const isFailure = await failingPrs.mapAsync(buildkite.isFailingGitDiff);
    failingPrs.forEach((pr, idx) => {
        pr.failureReason = isFailure[idx];
    });

    return _.groupBy(_.orderBy(failingPrs, 'updatedAt', 'desc'), 'failureReason');
};

const getPrsToMerge = async pullReqs => {
    // CLEAN I thiiiink means it's all green. anyway, without reviews it says BLOCKED
    return (await getShippedPrs(pullReqs)).filter(pr => pr.mergeStateStatus === 'CLEAN');
};

const mergePrs = async pullReqs => {
    return (await getPrsToMerge(pullReqs)).mapAsync(async pr => {
        try {
            return await mergePullRequest(pr);
        } catch (err) {
            // ignore errors in the merge to move on to the next one. Will pick up in next main loop
        }
    });
};

exports.getOpenPrs = getOpenPrs;
exports.getShippedPrs = getShippedPrs;
exports.getUpdatePrs = getUpdatePrs;
exports.getPrsToFixup = getPrsToFixup;
exports.mergePrs = mergePrs;

exports.test = async env => {
    const appClient = await client.getAppClient(env);

    const { body } = await appClient.v3request({ uri: '/repos/er9781/simonbot/pulls' });

    const number = body.first().number;
    console.log(body.first());

    const uri = `/repos/er9781/simonbot/pulls/${number}/merge`;
    console.log(uri);
    try {
        const tmp = await appClient.v3request({
            method: 'POST',
            uri,
            headers: {
                Accept: 'application/vnd.github.v3+json',
            },
            data: {
                merge_method: 'merge',
                commit_title: 'things',
                commit_message: 'things again',
                sha: body.first().head.sha,
            },
        });
        console.log(tmp);
    } catch (err) {
        console.log(err);
    }
};
