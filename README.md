# Pick Sheets

A phone app for picking orders from the VIP pick lists. Pickers scan the product
UPC barcodes with their iPhone camera instead of checking off paper. Outs go to a
supervisor to double-check, and management gets a record of every out and who
picked each order.

It runs as a web app that installs on the iPhone home screen, so there's no App Store.
The server keeps one shared database, so everyone sees the same orders live.

## How it works

**Trucks.** The home screen shows Trucks 1–6. Each truck lists its orders by stop
number. A pick list's `LOAD#` decides the truck: 201 is Truck 1, 202 is Truck 2,
and so on. An admin can change this under Settings.

**Picking (Picker)**
1. Open a truck, then a stop, and tap **Start picking**. The order is now yours,
   and other pickers see "<name> is picking this order".
2. Tap **Scan** and point the camera at the case barcode.
   - An item needed once is checked off right away.
   - An item needed more than once asks how many you picked. "All" fills in the rest.
   - An item **not on the order** gives an error beep. No substitutions.
   - A **barcode the app doesn't know** asks which line it is. The link is saved
     and shows up for a supervisor to check under *Barcodes to check*.
3. **Type code** works with the item # from the sheet (like `00439`) or the
   numbers under a barcode.
4. Tap any line to change the quantity, or to **Mark out** (*Out of stock* or
   *Can't find*, plus how many are short).
5. Lines printed `*OUT` on the VIP sheet come in already marked out. Scanning
   the item clears the out.
6. When every line is picked or out, tap **Finish order**. If anything is out, it's
   **Send to supervisor** instead.

**Supervisor**
- Gets a phone notification when an order has outs. These orders show up under
  *Outs to review*.
- For each out, the supervisor can **Confirm out** or choose **Found it**. Found it
  either adds the cases they pulled themselves, or sends the item back to the
  picker, who is notified.
- **Approve order** finishes it. Orders with no outs finish without approval.
- Can assign orders to a picker, take over an order, and check barcodes that
  pickers linked.

**Management**
- **Manage orders:** enter orders from the VIP pick list (header plus lines), and
  edit, assign, reopen or delete them. Each order also has a history of every
  scan and change.
- **Items & barcodes:** add items, scan a case barcode to link it to an item,
  or paste a whole list as `code, description, barcode`.
- **Reports:** every out (who marked it and who confirmed it) and finished orders
  (picker, approver, pick time). Both download as CSV.

**Admin**
- Everything above.
- **Employees:** create logins with a username and PIN (no email), set roles,
  reset forgotten PINs, and turn off accounts.
- **Settings:** which load # goes with which truck, database backup download,
  demo data, and printable test barcodes.

| Role | Pick | Review outs / approve | Enter orders, items, reports | Employees & settings |
|---|---|---|---|---|
| Picker | ✓ | | | |
| Supervisor | ✓ | ✓ | | |
| Management | ✓ | ✓ | ✓ | |
| Admin | ✓ | ✓ | ✓ | ✓ |

## Try it on a computer

You need Node.js 22.13 or newer.

```sh
npm install
npm start            # http://localhost:3000
```

1. Sign in as **admin**, PIN **1234**.
2. Go to Menu › Settings › **Load demo data**. This adds the Chuck's Carry Out pick
   list as Truck 1 / Stop 008, a few other orders, and three test logins:
   `picker`/1111, `supervisor`/2222 and `manager`/3333.
3. Settings › **Print test barcodes** shows barcodes for the demo items. Show them
   on screen or print them, then scan them with a phone.

The phone camera only works over **https**, so to scan with a phone the app has to
be hosted (see below).

## Put it online

The app is one small server plus a database file, which needs a persistent disk.
Either option costs roughly $5–10/month for 5 users.

- **Render** (simplest): push this repo to GitHub, then in Render choose
  *New › Blueprint* and pick the repo. `render.yaml` sets up the server and a
  1 GB disk. Set `ADMIN_PIN` to the first admin PIN you want.
- **Anything that runs Docker** (Fly.io, Railway, a server in the building): use
  the `Dockerfile` and mount a volume at `/data`.

| Setting | What it's for |
|---|---|
| `PORT` | Port to listen on (default 3000). |
| `DATA_DIR` | Folder for the database (`pick.db`). Must be on a persistent disk. |
| `ADMIN_PIN` | PIN for the first `admin` account, used only on the very first start. |
| `PUSH_CONTACT` | A `mailto:` address sent with notifications (required by Apple/Google). |

Back up the database with Settings › **Download backup**.

## Setting up the iPhones

1. Open the app's web address in **Safari**.
2. Tap **Share › Add to Home Screen**.
3. Open **Pick Sheets** from the Home Screen and sign in.
4. Supervisors (and pickers who want send-back alerts) should open
   Menu › My account › **Turn on notifications**. On iPhone this only works from
   the Home Screen app (iOS 16.4 or newer).

When Safari asks for camera access, tap **Allow**.

## Not done yet

- **Importing orders from VIP.** Orders are typed in for now. If VIP can export
  pick lists or the product list with UPCs (CSV or text), an import can replace
  the typing.
- **Kegs and MISC lines.** These can be entered and checked off by hand, but have
  no special handling yet.
- **Handheld scanners.** Bluetooth scanners that act as a keyboard will work in
  the "Type code" box. A dedicated scan-gun mode can come later.

## Project layout

```
server/            Node.js + Express API, SQLite via node:sqlite
  index.js         web server
  api.js           all API routes and permission checks
  db.js            database schema
  auth.js          username + PIN logins, roles
  push.js          phone notifications (Web Push)
  barcode.js       UPC / EAN / ITF-14 normalisation to GTIN-14
  demo.js          sample data from the real Truck 1 pick list
public/            the phone app (plain JavaScript modules, no build step)
  js/views/        one file per screen
  vendor/zxing/    barcode reader (zxing-cpp WebAssembly, MIT)
```
