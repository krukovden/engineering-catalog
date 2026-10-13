#!/usr/bin/env bash
set -eu

# The skill keeps its state in $HOME/.engineering-catalog; graders look in the workdir. The
# workdir's .engineering-catalog is a link to that real folder, so a grader sees exactly what the
# skill wrote there, however it wrote it.
mkdir -p "$HOME/.engineering-catalog"
rm -f "$HOME/.engineering-catalog/workspace.json" "$HOME/.engineering-catalog/repos.json"
rm -rf "$PWD/.engineering-catalog"
ln -s "$HOME/.engineering-catalog" "$PWD/.engineering-catalog"
