#!/usr/bin/env bash
# Brings a branch from the worker container into a clean clone on this
# computer, without git here ever running in the mounted folder.
#
#   scripts/fetch-from-container.sh <repository> <branch>
#
# The container writes a git bundle of the branch (docker exec ... git bundle
# create): plain data, objects and one ref. git here verifies it and fetches
# it into the clean clone as refs/remotes/container/<branch>, checking every
# object. Nothing is checked out and nothing is pushed; pushing is up to you,
# from the clean clone, with the command this script prints.
#
# Why a bundle: a fetch straight from the folder would run git's upload-pack in
# that repository, with its config, which the container's side controls. See
# the README, "Getting changes out of the container".
#
# Settings, from the environment:
#   VOICE_GW_DOCKER        the container (voice-workers)
#   VOICE_GW_DOCKER_REPOS  the repositories inside it (/repos)
#   VOICE_CLEAN_ROOT       where your clean clones are (the folder that holds
#                          this repository, usually ~/Developer)
#   VOICE_GW_DOCKER_BIN    the Docker CLI (docker)

set -euo pipefail

fail() {
  echo "fetch-from-container: $*" >&2
  exit 1
}

[ $# -eq 2 ] || { echo "usage: $0 <repository> <branch>" >&2; exit 2; }
repo=$1
branch=$2
container=${VOICE_GW_DOCKER:-voice-workers}
repos=${VOICE_GW_DOCKER_REPOS:-/repos}
docker=${VOICE_GW_DOCKER_BIN:-docker}
here=$(cd "$(dirname "$0")/.." && pwd -P)
clean_root=${VOICE_CLEAN_ROOT:-$(dirname "$here")}

[[ $repo =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || fail "not a repository name: $repo"
clean=$clean_root/$repo
[ -e "$clean/.git" ] ||
  fail "no clean clone at $clean. Clone it from GitHub first: git clone https://github.com/<owner>/$repo.git $clean"
clean=$(cd "$clean" && pwd -P)

# The clean clone must not be one of the container's repositories.
folder=$("$docker" inspect --format "{{range .Mounts}}{{if eq .Destination \"$repos\"}}{{.Source}}{{end}}{{end}}" "$container") ||
  fail "no container $container"
if [ -n "$folder" ]; then
  folder=$(cd "$folder" 2>/dev/null && pwd -P || echo "$folder")
  case "$clean/" in
    "$folder"/*) fail "$clean is inside the container's folder $folder; use a clone outside it" ;;
  esac
fi

# From here on, git runs only in the clean clone.
cd "$clean"
[[ $branch != -* ]] && git check-ref-format "refs/heads/$branch" || fail "not a branch name: $branch"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/voice-bundle.XXXXXX")
trap 'rm -rf "${tmp:?}"' EXIT
bundle=$tmp/branch.bundle

# Only what the clean clone does not have yet, if the container knows where
# origin's default branch is; otherwise the whole branch.
base=$(git rev-parse --verify --quiet 'refs/remotes/origin/HEAD^{commit}' || true)
bundle_from_container() {
  "$docker" exec "$container" git -C "$repos/$repo" bundle create --quiet - "refs/heads/$branch" "$@" >"$bundle" 2>"$tmp/err"
}
if ! { [ -n "$base" ] && bundle_from_container "^$base"; }; then
  bundle_from_container || fail "the container could not bundle $branch: $(tail -n 1 "$tmp/err")"
fi

git bundle verify --quiet "$bundle" >/dev/null 2>&1 || fail "the bundle from the container does not verify"
git -c transfer.fsckObjects=true fetch --quiet --no-tags --no-recurse-submodules --no-write-fetch-head \
  "$bundle" "+refs/heads/$branch:refs/remotes/container/$branch"

range=refs/remotes/container/$branch
[ -n "$base" ] && range="$base..$range"
echo "Fetched $branch from the container into $clean as container/$branch:"
git --no-pager log --oneline --no-decorate -n 20 "$range"
cat <<EOF

Nothing was checked out or pushed. Review it here:
  git -C $clean log -p ${base:+origin/HEAD..}container/$branch
Push it yourself when it is right:
  git -C $clean push origin refs/remotes/container/$branch:refs/heads/$branch
Check it out only once you trust it: a checkout applies its .gitattributes with the filters
configured on this computer, such as git-lfs.
EOF
