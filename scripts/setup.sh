#!/bin/bash
set -e

# Sets up the dev environment on a MacOS or GNU/Linux system

# working dir fix
SCRIPT_FOLDER=$(cd "$(dirname "$0")"; pwd)
cd $SCRIPT_FOLDER/.. # root

if [[ ! -d "node_modules" ]]; then
  npm install
fi

if [[ ! -f "localConfig.yml" ]]; then 
  cp config/sample-localConfig.yml ./localConfig.yml
fi

echo ""
echo "Setup complete!"
echo ""