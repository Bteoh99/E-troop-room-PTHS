# Setting up the e-Troop Store Room on the troop laptop

This guide turns an old Windows 10 laptop into the store room "server". Afterwards, anyone on the troop
Wi-Fi can open the app on their Android phone. Leaders unlock adding, editing and importing with a PIN.

You do not need to know programming. Follow the steps in order. The whole thing takes about an hour,
most of it waiting for downloads.

**What you need**

- The laptop: Windows 10, **64-bit**, plugged into power, connected to the troop Wi-Fi.
- The Windows password of an **administrator** account on the laptop.
- Internet on the laptop during setup and updates.
- The download address of the app (ask the troop's tech helper; it ends in `.git`).

---

## 1. Check that Windows is 64-bit

1. Press the **Windows key**, type `About your PC`, press **Enter**.
2. Under "Device specifications", **System type** must say **64-bit operating system**.
   If it says 32-bit, this laptop cannot be used.

## 2. Install Node.js (the engine the app runs on)

1. Open **Edge** or **Chrome** and go to **nodejs.org**.
2. Download **Node.js 22 LTS** for Windows. Pick the **Windows Installer (.msi)**, **64-bit (x64)**.
3. Open the downloaded file and click **Next** through the installer, keeping the default options.
   - On the page "Tools for Native Modules", **leave the box unticked**. It is not needed.
4. Click **Finish**.

## 3. Install Git (used to download and update the app)

1. Go to **git-scm.com** and click **Download for Windows**. Choose the 64-bit installer.
2. Run it and keep clicking **Next** with the default options, then **Install** and **Finish**.

## 4. Restart the laptop

Restart now. This lets Windows find Node.js and Git.

## 5. Download the app

We put the app in `C:\eTroop`.

> Do **not** use Desktop, Documents or a OneDrive folder. Those can be moved or synced
> and the app runs in the background.

1. Press the **Windows key**, type `cmd`, press **Enter**. A black "Command Prompt" window opens.
2. Type these two lines, pressing **Enter** after each. Replace the address with the one you were given.
   ```
   cd C:\
   git clone https://example.org/your-troop/e-troop-room.git eTroop
   ```
3. When it finishes, close the window.

## 6. Run the installer

1. Open **File Explorer** and go to `C:\eTroop\windows`.
2. Double-click **install.bat**.
3. Windows asks "Do you want to allow this app to make changes?". Click **Yes**.
4. A blue window shows the progress. Downloading and building takes **5–15 minutes**.
5. It will ask you some questions:
   - **Leader PIN**: choose **4 to 8 digits** and type it twice. The digits are not shown while you
     type. Give this PIN only to leaders.
   - **"Make the network Private?"**: only if the network named is the **troop Wi-Fi** and you trust
     it. Type `Y` and press **Enter**. Phones cannot connect while the network is "Public".
   - **"Keep the laptop awake when plugged in?"**: type `Y`. The laptop then never sleeps on mains
     power, and closing the lid does not stop the app.
6. At the end it shows something like:
   ```
   On phones:       http://192.168.1.50:3001
   ```
   **Write this address down.** Press **Enter** to close the window.

The app now starts by itself every time the laptop is switched on, even if nobody logs in.
Wait about a minute after switching the laptop on before using it.

Running **install.bat** again is safe. It repairs the installation and keeps all your items.

## 7. Make sure the Wi-Fi is "Private"

The installer offers to do this. To check it yourself:

1. Click the **Wi-Fi icon** at the bottom right, then **Properties** under the troop Wi-Fi.
   (Or: **Settings → Network & Internet → Wi-Fi →** click the network name.)
2. Under **Network profile**, choose **Private**.

## 8. Give the laptop a fixed address (recommended)

The router can give the laptop a different address after a restart, and then the bookmarks on the
phones stop working. To stop this, ask the router to always give the laptop the same address. This is
called a "DHCP reservation" or "address reservation".

1. Find the laptop's Wi-Fi "physical address":
   1. Open Command Prompt (step 5.1) and type `ipconfig /all`.
   2. Under "Wireless LAN adapter Wi-Fi", note the **Physical Address** (like `A4-C3-F0-12-34-56`).
   3. Note the **IPv4 Address** (like `192.168.1.50`).
2. Log in to the router's admin page. The address and password are usually on a sticker on the router.
3. Look for **DHCP**, **LAN** or **Address Reservation**.
4. Add a reservation that links the laptop's physical address to its current IPv4 address. Save.

If this is too difficult, write the address down again whenever it changes. You can always find it by
running `install.bat` again: it prints the address at the end.

## 9. Open the app on Android phones

1. Connect the phone to the **same troop Wi-Fi**. A guest network often blocks devices from talking to
   each other, so don't use one.
2. Open **Chrome** and type the address from step 6, for example `http://192.168.1.50:3001`.
   - Chrome may show "Not secure" next to the address. That is normal for an app that runs only on
     your own Wi-Fi.
3. To get an app icon: tap the **⋮** menu, then **Add to Home screen**, then **Add**.

**Leader mode**

1. Tap the **🔒 Leader** button and type the PIN.
2. Leader mode stays on for 30 days on that phone, or until you tap **Lock**.
3. After 5 wrong PINs, the phone must wait 5 minutes.

## 10. Changing or resetting the leader PIN

On the laptop:

1. Open Command Prompt (step 5.1) and type:
   ```
   cd C:\eTroop\backend
   npm run set-pin
   ```
2. Type the new PIN twice.

Every phone is then signed out of leader mode and needs the new PIN. If you forgot the PIN, do the same
thing; the old PIN is not needed.

## 11. Backups

- **When:** a copy of the database is made every time the app starts and every evening at 21:00.
  The newest 30 copies are kept.
- **Where:** `C:\eTroop\backend\data\backups`. Each copy is named after its date, like
  `store-2026-11-26.db`.
- **Back up right now:** double-click `C:\eTroop\windows\backup-now.bat`.

**Keep a copy somewhere else too.** If the laptop dies, the backups on it die with it.

**Google Drive**

1. Install **Google Drive for desktop**.
2. In its settings, choose **"Mirror files"**, not "Stream files". The app runs in the background
   and cannot see the Streaming `G:` drive.
3. Your Drive is then a normal folder, for example `C:\Users\YourName\My Drive`.

**Changing the backup folder**

1. Open `C:\eTroop\backend\.env` with **Notepad**.
2. Change the `BACKUP_DIR=` line, for example:
   ```
   BACKUP_DIR=C:\Users\YourName\My Drive\Store Room Backups
   ```
3. Save the file.
4. Run `install.bat` again, or restart the laptop.

A USB stick also works, as long as it always gets the same drive letter.

You can change the time of the evening backup (`BACKUP_HOUR`) and the number of copies kept
(`BACKUP_KEEP`) in the same file.

**Restoring a backup** (only if something went wrong)

1. Double-click `windows\stop.bat`.
2. In `C:\eTroop\backend\data`:
   1. Rename `store.db` to `store-broken.db`.
   2. Delete `store.db-wal` and `store.db-shm` if they exist.
3. Copy the backup you want (for example `backups\store-2026-11-20.db`) into `C:\eTroop\backend\data`
   and rename it to `store.db`.
4. Run `install.bat` again, or restart the laptop.

## 12. Updating the app

1. Double-click `C:\eTroop\windows\update.bat` and click **Yes**.
2. It backs up the database, downloads the newest version, rebuilds and restarts.

Your items, PIN, settings and backups are kept.

## 13. Stopping or removing the app

- `windows\stop.bat` stops the app until the next restart. Run `install.bat` to start it again
  straight away.
- `windows\uninstall.bat` stops the app from starting with Windows and removes the firewall rule.
  **Your data is kept** in `C:\eTroop\backend\data`. Copy that folder somewhere safe before you delete
  anything.

---

## Troubleshooting

**The phone says "This site can't be reached"**

1. Is the phone on the **same Wi-Fi** as the laptop? Not mobile data, and not a guest network.
2. Is the laptop switched on and awake? Did you wait a minute after switching it on?
3. On the laptop, open Edge and go to `http://localhost:3001`.
   - If that works, the problem is the network:
     - Make sure the Wi-Fi is **Private** (step 7).
     - The laptop's address may have changed. Run `install.bat` to see the current address, and
       consider a fixed address (step 8).
   - If that does not work either, the app is not running. Look at the log (below), or run
     `install.bat` again.

**"Leader PIN not set. Run set-pin on the laptop."** Do step 10.

**"Too many wrong tries"** Wait 5 minutes, then try again.

**The installer stops with a red PROBLEM message**

1. Read the message.
2. Most problems come from a missing internet connection while packages are downloading. Connect and
   run `install.bat` again.
3. If it says Node.js is missing or too old, repeat steps 2 and 4.

**Where is the log?** `C:\eTroop\backend\data\logs\server.log`. Open it with Notepad. The newest
lines are at the bottom. If the app keeps stopping, the reason is written there.

**"Port 3001 is already in use"** Another program uses that port. Change `PORT=` in `backend\.env`
to, for example, `3002` and run `install.bat` again. Phones then use `:3002` in the address.

**After a big Windows update the app does not start.** Run `install.bat` again.
