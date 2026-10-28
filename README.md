# Pick Sheets · Perry Distributors Inc.

> **Proof of concept.** This is a working demo built to show how barcode picking could replace paper pick sheets. It isn't in production use yet.

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

**The day.** There's no fixed schedule. A day starts with its first order and ends
when every order on every truck is done ("All trucks loaded"). The top of the Trucks
screen shows totals across all trucks: cases, picked, left and out. When the day ends,
it shows the day's **top sellers** and **most out** items, and management gets a
notification. The next order entered starts a new day.

**Pick rates.**
- Pick rate is cases picked per hour of active picking, for example *134 cases/hr*.
  It turns **red** below a target that supervisors set (default 100).
- Only time spent picking counts. A gap of more than 10 minutes between scans
  counts as 10 minutes, so breaks don't lower anyone's rate.
- Next to it: how many items each person marked out, and how many of those a
  supervisor *found on the shelf*.
- Employees see their own rate on the Trucks screen and under My account.
  Supervisors, management and admins see everyone's under **Pick rates**, for
  today or the last 7 days.
- Test and demo orders count while trying the app out. Turn this off under
  Pick rates › Change once real orders start.

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
   **Send to supervisor** instead. The app then offers **the next order** on the same
   truck (the lowest stop nobody has started). **Start next order** on a truck screen
   does the same.

**Ring scanner (SA1200 or any Bluetooth scanner in keyboard mode).** Once the order is
started, just pull the trigger. No need to tap Scan. The app tells the scanner's very
fast typing apart from a person typing, and handles the scan like a camera scan: an
item needed once is checked off, larger quantities open the quantity popup, and wrong
items beep. If the quantity popup is open, a scan is ignored with a reminder to tap
Add or Cancel first, so a barcode can't end up as a quantity. With an item open
under Items & barcodes, a ring scan links that barcode to the item.
Set up and test the scanner under **My account › Ring scanner**: pair it with the
iPhone in Bluetooth keyboard (HID) mode, with Enter after each scan.

Also on the pick screen:
- **No signal?** Keep picking. Changes are saved on the phone ("No signal. 3 changes
  are saved…") and sent automatically when it reconnects, with the time they
  really happened, so pick rates stay right. Scans still match while offline for
  barcodes the app already knows. Finishing an order needs signal.
- **↶ Undo** takes back the last change (a scan, a quantity, an out).
- **Find on this order** filters a long list by name or item #.
- **Big text** shows one item at a time in large print with **✓ Picked all**, **Skip**
  and **Back**. The phone remembers which view each person likes.
- **Notes** from drivers, supervisors and management show at the top.

**Driver**
- Sees the trucks and orders but can't pick.
- Leaves **loading notes** on a truck, for today's load or for every day ("Load stop 9
  first, Stella on top"), and notes on an order or a store. Pickers see them on the
  truck screen and the pick list.
- A truck's **Load order** tab lists stops in loading order: the last stop goes on
  first.

**Supervisor**
- Gets a phone notification when an order has outs. These orders show up under
  *Outs to review*.
- For each out, the supervisor can **Confirm out** or choose **Found it**. Found it
  either adds the cases they pulled themselves, or sends the item back to the
  picker, who is notified.
- **Approve order** finishes it. Orders with no outs finish without approval.
- Can assign orders to a picker, take over an order, and check barcodes that
  pickers linked.
- **Floor** shows who is picking which order and how far along, each person's pick
  rate, and who has gone 10+ minutes without a scan.
- **Running out:** when the same item is marked out on 3 orders in one day,
  supervisors and management get a notification, and it's listed on the Floor screen.
- Can add notes to orders, stores and trucks.

**Management**
- **Import from VIP:** choose the file VIP saved (the IN005 pick list as text, or a
  CSV) or paste it. Every order is shown first, with orders already on today's
  trucks and new item codes flagged, and nothing is created until **Import**.
  *This was built from a photo of the printed sheet and will be matched to VIP's
  real export files once samples arrive.*
- **Manage orders:** type orders in by hand when needed, and edit, assign, reopen
  or delete them. Each order also has a history of every scan and change.
- **Items & barcodes:** add items, scan a case barcode to link it to an item,
  or paste a whole list as `code, description, barcode`.
- **Reports:** every out (who marked it and who confirmed it), finished orders
  (picker, approver, pick time), **Days** (totals, top sellers and most out for
  each day) and **Out trends** (which items run out most over weeks, for
  purchasing). All of them download as CSV.
- When all trucks are loaded, management gets a notification with the totals, the
  top seller and the item most out.

**Admin**
- Everything above.
- **Employees:** create logins with a username and PIN (no email), set roles,
  reset forgotten PINs, and turn off accounts. When someone taps **Forgot your PIN?**
  on the sign-in screen, admins get a notification and a **Set new PIN** button.
- **Settings:** which load # goes with which truck, database backup download,
  demo data, and printable test barcodes.

| Role | Pick | Notes | Review outs, Floor | Orders, items, reports | Employees & settings |
|---|---|---|---|---|---|
| Driver | | ✓ | | | |
| Picker | ✓ | read | | | |
| Supervisor | ✓ | ✓ | ✓ | | |
| Management | ✓ | ✓ | ✓ | ✓ | |
| Admin | ✓ | ✓ | ✓ | ✓ | ✓ |

**Updates.** When a new version is deployed, open phones show *"A new version of
the app is ready. Tap to update."*

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
3. Settings › **Start Chuck's Carry Out test run** adds a fresh copy of the real
   Truck 1 / Stop 008 pick list (24 lines, 113 cases, 01172 printed `*OUT`) to practice on.
   You can press it as many times as you like.
4. Settings › **Print test barcodes** shows barcodes for the demo items. Show them
   on screen or print them, then scan them with a phone.

The phone camera only works over **https**, so to scan with a phone the app has to
be hosted (see below).

## Automated test

```sh
npm test
```

This replays the Chuck's Carry Out pick list from start to finish against a throwaway
database, the same way the phones do it:
1. The order lands on Truck 1, and 01172 arrives already marked out.
2. The picker claims the order, and a second person can't take it.
3. The picker scans every case barcode and marks BUD SELECT 30/12 out ("can't find").
4. A supervisor has to confirm both outs before approving.
5. The outs and finished-order reports show the right people and numbers.

It also checks that pickers are blocked from supervisor and management actions, and
that barcode numbers are handled correctly (UPC-A, EAN-13, ITF-14 and UPC-E).

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

### Backups

The app backs itself up every night and whenever all trucks are loaded. It keeps the
newest 7 copies on its own disk. Settings › Backups shows the last one and has
**Back up now** and **Download a copy**.

A copy on the same disk doesn't help if the disk itself is lost, so also send backups
to outside storage. Any service that speaks the S3 protocol works, for example
Backblaze B2 or Cloudflare R2, which cost about nothing at this size. Create a bucket
and an access key there, then add these settings in Render (Environment):

| Setting | Example |
|---|---|
| `BACKUP_S3_ENDPOINT` | `https://s3.us-west-004.backblazeb2.com` |
| `BACKUP_S3_BUCKET` | `perry-pick-backups` |
| `BACKUP_S3_KEY_ID` | the key ID |
| `BACKUP_S3_SECRET` | the secret key |
| `BACKUP_S3_REGION` | `us-west-004` (Cloudflare R2: `auto`) |

To restore, stop the app, put the backup file in place of `pick.db` on the disk, and
start it again.

## Setting up the iPhones

1. Open the app's web address in **Safari**.
2. Tap **Share › Add to Home Screen**.
3. Open **Pick Sheets** from the Home Screen and sign in.
4. Supervisors (and pickers who want send-back alerts) should open
   Menu › My account › **Turn on notifications**. On iPhone this only works from
   the Home Screen app (iOS 16.4 or newer).

When Safari asks for camera access, tap **Allow**.

## Not done yet

- **Matching the VIP import to the real export files** (waiting on samples), and a
  product list import with UPCs.
- **Kegs and MISC lines.** These can be entered and checked off by hand, but have
  no special handling yet.

## Project layout

```
server/            Node.js + Express API, SQLite via node:sqlite
  index.js         starts the web server
  app.js           Express app (used by index.js and the tests)
  api.js           all API routes and permission checks
  db.js            database schema
  auth.js          username + PIN logins, roles
  push.js          phone notifications (Web Push)
  barcode.js       UPC / EAN / ITF-14 normalisation to GTIN-14
  days.js          work days: totals, top sellers, end-of-day notification
  rates.js         pick rate (cases per active hour)
  vip.js           reads VIP pick lists (IN005 text, CSV)
  backup.js        nightly backups, local and S3-compatible
  version.js       app version, for "new version available"
public/js/wedge.js tells ring-scanner input apart from typing
  demo.js          sample data and the Chuck's Carry Out test run
test/              automated tests (npm test)
public/            the phone app (plain JavaScript modules, no build step)
  js/views/        one file per screen
  vendor/zxing/    barcode reader (zxing-cpp WebAssembly, MIT)
```
