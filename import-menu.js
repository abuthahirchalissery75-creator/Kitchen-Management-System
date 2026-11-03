'use strict';
/**
 * Replaces the ENTIRE menu in an existing database with the items from menu.json.
 * Stop the server first, then run:   node import-menu.js        (or: npm run import-menu)
 * Old orders are not touched (they keep their own copy of item names and prices).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
if (!fs.existsSync(DATA_FILE)) { console.log('No database yet - start the server once (it creates the menu from menu.json), nothing to import.'); process.exit(0); }
const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf8'));
const old = (db.items || []).length;
db.items = menu.map((m) => ({ id: crypto.randomBytes(6).toString('hex'), name: m.name, category: m.category, price: m.price, available: true }));
if (db.settings && db.settings.restaurantName === 'My Kitchen') db.settings.restaurantName = 'Crave Yard';
fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak');
fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
console.log(`Deleted ${old} old items, added ${db.items.length} items from menu.json. Backup: ${DATA_FILE}.bak`);
