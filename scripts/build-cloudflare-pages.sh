#!/usr/bin/env bash
set -euo pipefail

npm install
npm run build:version
make prepare-all JOBS="${JOBS:-2}"
python -m pip install --default-timeout=120 -r requirements-docs.txt

rm -rf _site site
mkdir -p _site/docs
rsync -a ./ ./_site/ \
  --exclude ".git/" \
  --exclude ".github/" \
  --exclude ".agents/" \
  --exclude ".claude/" \
  --exclude ".venv/" \
  --exclude ".cache/" \
  --exclude "_site/" \
  --exclude "docs/" \
  --exclude "node_modules/" \
  --exclude "site/" \
  --exclude "tests/" \
  --exclude "patches/"
zensical build --clean
rsync -a --delete site/ _site/docs/
rm -rf site
touch _site/.nojekyll
