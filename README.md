# ChickenCo Pick Sheets (demo)

A phone app that replaces paper pick sheets. Pickers open an order, scan the QR
code on each item, and the app checks it off. Administrators keep the item list
(SKUs) and create pick sheets.

It is a web app that installs to the home screen (a "PWA"), so it runs on
iPhone and Android with no app store. It has no build step and no server code:
it is plain HTML, CSS and JavaScript.

## What it does

**Pickers**
- See every open pick sheet with its progress.
- Open a sheet to see the full list of items: what's left to pick and what's done.
- **Scan QR** opens the camera. Scanning an item:
  - needed once → checked off right away (beep + vibrate);
  - needed more than once → asks how many you picked (big +/– buttons, "All");
  - not on this sheet, or already fully picked → error beep and a warning.
- **Type SKU** for damaged labels or when the camera isn't available.
- Tap any line to check it off or set its quantity by hand.
- When everything is picked, mark the order complete.

**Administrators** (Admin, PIN `1234` by default)
- **Items:** add, edit or delete items (SKU, name, location). You can also paste a
  whole list from a spreadsheet (`SKU, Name, Location`, one per line).
- **Print QR labels** for every item to stick on shelves or bins.
- **Pick Sheets:** create or edit sheets: order number, customer, items and
  quantities. You can add items by typing or by scanning their labels. You can
  also reset progress, reopen or delete a sheet.
- **Settings:** change the PIN, load demo data, back up or restore data, and erase everything.

The QR code on a label holds the plain SKU text (for example `CC-1004`). Labels
from another system work too if their QR holds the SKU (a `SKU:` prefix is fine).

## Try it

The camera only works over **https** (or `localhost`), so a phone can't use it
from a plain `http://` address.

**On a computer:**
```sh
npx http-server -c-1 .     # or: python3 -m http.server 8000
```
Open http://localhost:8080, tap **Load demo data**, then go to Admin → Items →
Print QR labels and point a phone at the screen to try scanning.

**On a phone:** host the folder on any HTTPS static host. The easiest is GitHub
Pages: in the repo go to Settings → Pages, choose "Deploy from a branch" and
pick the branch and `/ (root)`. Open the URL on the phone. To install it, use
Share → Add to Home Screen (iPhone) or ⋮ → Install app (Android).

## Demo limitations

- **Data stays on each phone** (browser localStorage), so two phones don't
  share pick sheets yet. Use Settings → Download/Restore backup to move data.
  Real use needs a small shared backend; all data access is already in
  `js/store.js` so it can be swapped for API calls.
- The admin PIN is a simple local lock, not real security.

## Project layout

```
index.html            app shell
css/styles.css        styles (mobile-first, large tap targets)
js/store.js           data: items, pick sheets, settings (localStorage)
js/scanner.js         camera + QR decoding (native BarcodeDetector, jsQR fallback)
js/app.js             screens and navigation
sw.js                 offline cache. Bump VERSION when you ship changes
vendor/               jsQR (Apache-2.0), qrcode-generator (MIT)
```
