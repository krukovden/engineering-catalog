#!/bin/sh
# Line count of every file changed in a range, largest first, so a reviewer sees
# at a glance which files have grown past the thresholds in references/checklist.md.
#
#   scripts/file-sizes.sh              # main...HEAD
#   scripts/file-sizes.sh <from> <to>  # <from>...<to>
#
# Output: one line per file, `lines  marker  path`, where the marker is `!` beyond
# 300 lines and `!!` beyond 500. Deleted files have no size and are not listed.
set -eu

FROM="${1:-main}"
TO="${2:-HEAD}"

# Sizes are read at <to>, not from the working tree, so the numbers match the commits under review.
git diff --name-only --diff-filter=d "$FROM...$TO" -- | while IFS= read -r file; do
  git cat-file -e "$TO:$file" 2>/dev/null || continue
  n=$(git show "$TO:$file" | wc -l | tr -d ' ')
  if [ "$n" -gt 500 ]; then mark='!!'
  elif [ "$n" -gt 300 ]; then mark='!'
  else mark=''
  fi
  printf '%6d  %-2s  %s\n' "$n" "$mark" "$file"
done | sort -rn
