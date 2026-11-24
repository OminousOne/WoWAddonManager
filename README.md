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
