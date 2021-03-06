var buildkite = require('./client');
var pullrequest = require('../pullrequest/pullrequest');
var _ = require('lodash');
var http = require('../http/http');

const getDiffPatch = async pr => {
    if (pr.cachedPatch === undefined) {
        try {
            // we want builds only on the latest commit. Others are now void.
            const recentCommit = pullrequest.getCommits(pr).first();
            const { body } = await buildkite.request({
                uri: '/builds',
                query: { branch: pullrequest.getBranch(pr), commit: recentCommit.oid },
            });
            const backendTest = body.filter(build => build.pipeline.name.includes('backend-test')).first();

            const artifactUrl = _.minBy(
                backendTest.jobs.filter(job => job.name && job.name.includes('backend verifications')),
                job => job.name.length
            ).artifacts_url;

            const artifacts = (await buildkite.request({ url: artifactUrl })).body;
            const patchUrls = artifacts.filter(a => a.path.includes('.patch'));
            if (patchUrls.length > 0) {
                const downloadUrl = (await buildkite.request({ url: patchUrls.first().download_url })).body.url;
                const patch = (await http.request({ url: downloadUrl, method: 'GET' })).body;

                // cache the patch on the pr object. yay mutability.
                pr.cachedPatch = patch;
            }
        } catch (err) {
            // on any error, we'll just skip this one happily?
            console.log(err);
        }
    }

    return pr.cachedPatch;
};

exports.getDiffPatch = getDiffPatch;

// returns "failingGitDiff" if failing git diff, "other" for other failing statuses.
exports.isFailingGitDiff = async pr => {
    const patch = await getDiffPatch(pr);
    return patch ? 'failingGitDiff' : 'other';
};

const requiredScopes = ['read_artifacts', 'read_builds', 'read_user'];
exports.requiredScopes = requiredScopes;

exports.checkAuth = async () => {
    const { body } = await buildkite.request({ uri: '/access-token' });
    // we have a set of scopes we expect to have access to.
    return body.scopes && requiredScopes.every(scope => body.scopes.includes(scope));
};
