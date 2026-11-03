# Kitchen Order Management System

Live order board for a restaurant kitchen. Orders from **tables, Swiggy, Zomato, takeaway** (or any platform you add) show up instantly on the kitchen screen via WebSocket, with sound alerts, colour-coded wait times and optional WhatsApp messages.

## Run it

Requires Node.js 18 or newer.

```bash
npm install
npm start
# open http://localhost:3000
```

**First login.** There is no shared default password any more. On the first run the server creates two accounts, `admin` (Admin) and `kitchen` (Kitchen admin), each with a **random password** that is printed in the terminal (and saved in `data/FIRST-LOGIN.txt`, which is deleted once the admin sets a new password). On first sign-in each user is asked to choose their own password before going on. You can also choose the starting passwords yourself with `ADMIN_PASSWORD` / `KITCHEN_PASSWORD` in `.env`.

Passwords must be at least 8 characters, not common (like `admin123`, `password1`), not only digits, and not contain the username. Kitchen admins you add or reset are also asked to set their own password at first login. If you upgrade from an older version that still used `admin123` / `kitchen123`, those accounts are forced to change it at next login.

Tip: if Chrome says "password found in a data breach", pick a different, unique password for this site (don't reuse one from another site).

Data is stored in `data/db.json` (created automatically). Back up that file to keep your orders.

## Menu

The full **Crave Yard** menu (128 items: Shawai, Alfaham, Chinese, Shawarma, Mandi, shakes, juices, mojitos, hot drinks, add-ons) is in `menu.json` and is loaded automatically on first run.
If you already ran an older version with the sample menu, **stop the server** and run `npm run import-menu` - it deletes the old menu, loads `menu.json` and keeps a backup (`data/db.json.bak`). Existing orders are not changed. To change prices later, use Admin > Items (or edit `menu.json` and run the import again).

## Integrations: Swiggy, Zomato, POS (automatic orders)

Admin > **Integrations** > **+ Connect POS**. Pick ONE way: **(1) I have an API key**: paste the address and API key your POS gave you. An **Ably** key (looks like `ABLY_API_KEY=xxxx.yyyy:zzzz`) also works: paste the key and the channel name your POS gives you (no address needed). An address starting with **wss://** is a WebSocket (orders arrive live, reconnects by itself); **https://** is checked every few seconds (only orders placed after connecting are imported). **(2) My POS sends orders to us**: the app gives you an address and a key to enter in your POS settings (the app must be reachable online). Every order it sends appears in **Preparing** on the kitchen board (with live update and sound); when the kitchen marks Ready / Served, the app can tell your POS back.

- **Add / edit / delete** integrations, switch each one on or off, make a new API key at any time (the old one stops working).
- **Sending orders in:** `POST <webhook URL>` with header `x-api-key: <key>` (or `Authorization: Bearer <key>`, or `?key=<key>` on the URL if the sender cannot set headers) and a JSON body. Items are matched to your menu by name; unknown items are kept as sent. The same order id sent twice is ignored, so retries never create duplicates.
- **Field mapping:** leave blank to auto-detect common names (`order_id`, `customer.name`, `items[].name`, `quantity`, `price` ...) or type the exact paths your system uses (for example `order.items`, `dish.title`).
- **Status back to the POS:** optional per integration: URL, method, an API-key header, and the words your POS expects for preparing / ready / served. Failed sends are retried once and listed in **Recent activity**.
- **Send test order** runs a pasted real payload through the same code, so you can check the mapping before going live.
- Swiggy and Zomato normally give orders to restaurants through a POS or partner platform rather than a public API, so use the details that system asks for. Your server must be reachable from the internet (tunnel or hosting). Callback URLs pointing at private/internal addresses are blocked unless `ALLOW_PRIVATE_CALLBACKS=1`.

## What each role can do

**Admin**
- Log in, see the **Overview** (today's total orders, revenue, preparing/ready/served counts, orders and revenue per platform, top items, average prep time) - updates live
- **Kitchen admins**: add, edit, disable, delete (and reset their passwords)
- **Items**: add, edit, delete, mark unavailable
- **Platforms**: add, edit, delete (e.g. Table, Swiggy, Takeaway, Zomato) with a colour, and whether it asks for a table number
- **Orders**: create, edit, delete, change status, filter by platform/status, chat with the customer on WhatsApp
- **Settings**: colour thresholds, WhatsApp options, change own password

**Kitchen admin** (`/kitchen.html`)
- Sees orders in three sections: **Preparing**, **Ready**, **Served**
- Moves orders between sections with one tap (Mark Ready / Mark Served / Back / Reopen)
- Cards go **green -> orange -> red** as time passes (defaults: orange after 10 min, red after 20 min; change in Admin > Settings). Preparing is timed from when the order was placed, Ready from when it was marked ready.

## Integrations

- **WebSocket** - every change (new order, status update, menu/platform edit) is pushed to all open screens. The page reconnects automatically if the connection drops.
- **Sound** - generated in the browser (no audio files). New order chime on the kitchen board, "ready" chime on the admin screen, and an alarm when an order turns red. Browsers block audio until the page is clicked once, so click anywhere after opening; the 🔔 button mutes/unmutes.
- **WhatsApp (automatic customer messages)** - when an order has a customer WhatsApp number, the server messages the customer by itself, once per order per step:
  1. **Accepted** - right when the order is created (includes items and total)
  2. **Ready** - when the kitchen marks it Ready
  3. **Served** - when it is marked Served (asks for a **review**, using your review link)

  Admin > **WhatsApp messages** lets you add, edit, turn on/off and delete these messages. Placeholders you can use: `{name} {order} {restaurant} {items} {total} {platform} {table} {review_link}`. You can add several messages for the same step (all enabled ones are sent). Set your Google review link in Admin > Settings > Review link. A master switch in Settings turns all automatic messages off. Each order shows which messages were sent (or failed, with Retry) and has a resend button for each step. Messages are sent from your own number (default `9778238561`).

### Set up automatic WhatsApp (recommended: link your phone, 1 minute)

1. `npm start`, log in as admin, go to **Settings > Automatic messages: link your phone** and press **Link WhatsApp number**.
2. On the phone with your number: WhatsApp > **Linked devices** > **Link a device** > scan the QR code shown.
3. Done. The page shows "Linked as +91...". The session is saved in `data/wa-auth/`, so it reconnects after a restart. Use **Unlink** to disconnect.

Keep the phone online now and then (WhatsApp unlinks devices after ~14 days offline), and keep the server running. This uses the same technique as WhatsApp Web through an **unofficial library**, so it is not endorsed by WhatsApp: use it only for messages to customers who just ordered from you, don't send bulk or promotional messages (the server already spaces messages ~2.5 s apart), and accept that WhatsApp could restrict the number if it detects abuse.

### Alternative: official WhatsApp Cloud API (Meta)

Use this if you want a fully supported setup. Register your number in the WhatsApp Cloud API (it must not be active in the normal WhatsApp app), put `WHATSAPP_PHONE_ID` and `WHATSAPP_TOKEN` in `.env`, restart. Meta only allows free-text to customers who messaged you within 24 hours; otherwise an approved message template is needed (edit `sendViaApi()` in `server.js`). If a phone is linked, the server uses it first, otherwise the Cloud API.

## Using it in a real kitchen

- Put the server on a PC or a small cloud VM and open `http://<server-ip>:3000/kitchen.html` on the kitchen tablet/TV. For internet access, put it behind HTTPS (e.g. Caddy or nginx) - the WebSocket upgrades to `wss://` automatically.
- Set `TZ=Asia/Kolkata` (in `.env`) so daily order numbers reset at your local midnight.

## Project layout

```
server.js        Express API + WebSocket + JSON storage + WhatsApp sending
wa-link.js       "link your phone" WhatsApp sender (QR code, Baileys)
public/          index.html (login), admin.html/js, kitchen.html/js, common.js, style.css
data/db.json     created on first run (data/wa-auth = linked WhatsApp session, keep private)
```

## Text size (A- / A+)
Both the kitchen board header and the admin sidebar have **A− / A+** buttons (70% to 260%). It is remembered separately for the kitchen screen and the admin on each device. Click the percentage to go back to 100%. On big monitors the size also grows automatically.

## POS changes and editing items
- Live connections (Ably / WebSocket): when the same order is sent again with different items, it is **updated** here; when the POS sends a cancel / reject / delete for it, it is **removed** here (served orders are never touched). Tick **Wait until my POS accepts the order** to keep orders waiting in the POS out of the kitchen until the POS says accepted. **What the POS sent** on each integration card shows the last messages, handy when something does not match.
- Open any order in Admin, press **Edit items** to change name, quantity or price, add items or remove them (works for POS orders and orders with price 0).

## Orders from your POS: waiting, changes, cancel
With **Wait until my POS accepts the order** ticked (on by default), a new order that is still waiting in the POS stays off the kitchen board and shows on the integration card under "waiting for the POS to accept". When the POS accepts it, it moves to Preparing with sound. If the POS changes the items, they change here too; if it cancels or rejects, the order is removed; Ready / Served in the POS follows here (never backwards). You can always press **Send to kitchen** on a waiting order yourself. Use **What the POS sent** on the card to see the exact messages your POS sends.

## Purchase (suppliers order from a private link)

Admin > **Purchase** has four tabs: *Purchase orders*, *Suppliers & links*, *Items*, *WhatsApp*.

- **Suppliers & links**: Kitchen master and Juice master each get their own secret link (`/buy/<token>`). Copy it, send it on WhatsApp, show a QR code, add an optional PIN, or **Reset link** (the old link stops working at once).
- **Items**: add, edit, delete, mark out of stock. Each item belongs to one shop or both.
- **WhatsApp**: receivers (name, number, which orders they get), auto-send on/off, and an editable message with placeholders `{number} {label} {person} {category} {date} {items} {note} {deliverBy} {restaurant}`. Sends through the number linked in Settings.
- The supplier opens the link on a phone, picks items and quantities, can choose "Order same as last time", add a note and a needed-by time, and places the order. Admin marks it *Received* when the goods arrive.
