# AddOn Ledger

A desktop addon manager for World of Warcraft. AddOn Ledger keeps each game installation's addon library separate.

## Run from source

Install Node.js 24 or later, then run:

```sh
npm ci
npm start
npm test
```

The app scans common Battle.net locations on macOS and Windows and common Wine and Lutris locations on Linux. Use **Add installation** for custom Battle.net locations or Wine and Proton prefixes. Select either the World of Warcraft root or a client folder such as `_retail_`. Switch installations with the sidebar selector and use **Rescan library** after changing files outside the app.

## Discover and install

Open **Discover** to browse or search the catalog for the selected client. WoWInterface and Tukui work out of the box. For CurseForge, use **Sources** to save your [CurseForge API key](https://support.curseforge.com/support/solutions/articles/9000208346) in the system credential store, or launch with the `CURSEFORGE_API_KEY` environment variable. CurseForge authors control whether their addons may be distributed by third-party clients.

An install can contain several addon folders. AddOn Ledger groups those folders together and preserves unrelated and manually installed folders if their names overlap.
