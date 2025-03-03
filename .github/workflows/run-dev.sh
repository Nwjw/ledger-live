#!/bin/bash

rm /home/arman/.config/Electron/SingletonLock
# rm -r /home/arman/.config/Electron/Cache

rm -r /home/arman/ledger-live/apps/ledger-live-desktop/dist
rm -r /home/arman/ledger-live/apps/ledger-live-desktop/.webpack

pnpm store prune
pnpm rebuild
pnpm run dev:lld
