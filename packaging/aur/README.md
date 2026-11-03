# AUR packaging

This directory maintains the `t3pp-bin` and `t3pp-nightly-bin` AUR packages. Both repackage the
x86_64 AppImage from this repository's GitHub Releases and install a `t3pp-desktop` or
`t3pp-nightly-desktop` launcher.

## Publishing

The release workflow calls `.github/workflows/publish-aur.yml` after publishing a GitHub release;
the workflow can also be run manually for a specific tag. It selects the stable or nightly
package, then updates its version and checksums, builds it, regenerates `.SRCINFO`, and pushes it
to the AUR. The release workflow runs it only when the `AUR_SSH_PRIVATE_KEY` secret is set; the
key's AUR account must own both package names.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v1.2.3 \
  packaging/aur/scripts/release.sh
```
