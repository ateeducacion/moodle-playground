#!/usr/bin/env bash
set -euo pipefail

npm install
npm run build:version
make prepare-all JOBS="${JOBS:-2}"
python -m pip install --default-timeout=120 -r requirements-docs.txt

rm -rf dist-site site
mkdir -p dist-site/docs
rsync -a ./ ./dist-site/ \
  --exclude ".git/" \
  --exclude ".github/" \
  --exclude ".venv/" \
  --exclude ".cache/" \
  --exclude "dist-site/" \
  --exclude "docs/" \
  --exclude "node_modules/" \
  --exclude "site/" \
  --exclude "tests/" \
  --exclude "patches/"
zensical build --clean
rsync -a --delete site/ dist-site/docs/
rm -rf site
touch dist-site/.nojekyll
