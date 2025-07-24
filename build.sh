#!/usr/bin/env bash

# Exit immediately on error, treat unset vars as errors, and propagate errors in pipelines
set -euo pipefail

# Configuration
ZIP_NAME="lambda.zip"

# Remove any pre-existing zip archive with the same name
rm -f "$ZIP_NAME"

# Create deployment zip from the current directory, excluding any existing zip files
# -r: recurse, -q: quiet, -9: best compression
zip -rq9 "$ZIP_NAME" . -x "*.zip"

echo -en "\n✅ Created $ZIP_NAME with index.mjs at the top level (excluding other .zip files)." 