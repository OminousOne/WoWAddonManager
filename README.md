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

Open **Discover** to browse addons for the selected client or search across game editions. A search result with **No compatible release** can still be opened to check its supported versions. Click an addon card to see its full description, release notes, and screenshots when the provider offers them.

WoWInterface, Tukui, and WowUp Hub work out of the box. WowUp Hub indexes addons published on GitHub and GitLab, including WoW Forever releases. To include CurseForge results in the app, save your [CurseForge API key](https://support.curseforge.com/support/solutions/articles/9000208346) in **Sources** or launch with the `CURSEFORGE_API_KEY` environment variable. Without a key, searches across all enabled sources offer a link to run the same search on the CurseForge website. CurseForge authors control whether their addons may be distributed by third-party clients.

An install can contain several addon folders. AddOn Ledger groups those folders as one package. To migrate a manually installed addon, find it in Discover and choose **Install**. If the archive overlaps any manual folders, the app lists them and asks before replacing them. The migrated addon then receives catalog updates.

## Maintain a library

- **Check updates** refreshes release information for managed catalog addons. The app also checks in the background when you open or switch installations.
- **Update all** applies available updates for the selected client and skips pinned addons. Open an addon's details to pin it, repair the currently installed release when the provider still offers it, or remove it.
- **Import ZIP** adds a local addon archive to the selected client. ZIP imports and manually installed folders do not participate in catalog update checks.
- Managed removals affect the recorded addon folders under `Interface/AddOns`. WoW's `WTF` folder and saved settings are preserved.

## Build desktop packages

On each target OS with Node.js 24, run:

```sh
npm ci
npm test
npm run package
```

The packages are written to `dist/`. The GitHub Actions **Desktop builds** workflow builds Linux x64 AppImage and Debian packages, macOS DMGs for Apple Silicon and Intel, and the Windows x64 installer. It then launches each packaged app against temporary Retail and Classic libraries. Download installers from the workflow run's artifacts.

On Debian or Ubuntu, use the `.deb` if your system restricts user namespaces for AppImages. The macOS builds use ad-hoc signing and are not notarized. The Windows installer has no publisher signature.
