# TrackMyRMA apps — iPhone, Android, Windows, Mac

All four apps open **www.trackmyrma.com** inside an app window, so every update to the website reaches the apps at once. Re-build the apps only when the app shell changes (icon, name, permissions).

| App | Made with | Code | File |
|---|---|---|---|
| Android | Capacitor | `apps/mobile/android` | `TrackMyRMA-android.apk` |
| iPhone / iPad | Capacitor | `apps/mobile/ios` | built in Xcode on a Mac |
| Windows | Electron | `apps/desktop` | `TrackMyRMA-1.0.0-win-x64.exe` |
| Mac | Electron | `apps/desktop` | `TrackMyRMA-1.0.0-mac-universal.dmg` |

App ID everywhere: `com.trackmyrma.app`.

## 1. Get the Android, Windows and Mac files (GitHub builds them)

1. github.com/sbatra65-blip/rma-cloud → **Actions** → **Build apps** → **Run workflow** → Run.
   (It also runs when a tag like `app-v1.0.1` is pushed.)
2. Wait about 10 minutes for the run to finish (green tick).
3. Open the run → scroll to **Artifacts** → download **TrackMyRMA-android**, **TrackMyRMA-windows**, **TrackMyRMA-mac** (each is a .zip; unzip it).

### Install
- **Android:** copy the `.apk` to the phone → open it → allow "Install unknown apps" for Files/Chrome when asked → Install.
- **Windows:** run the `.exe`. Windows SmartScreen may say "Windows protected your PC" because the app is not code-signed yet → **More info → Run anyway**.
- **Mac:** open the `.dmg` → drag TrackMyRMA to Applications. The first time, right-click the app → **Open** → **Open** (it is not notarised yet).

## 2. iPhone — build on your Mac

Needs: Mac with **Xcode** (App Store, free), **Node.js 22** (nodejs.org) and **Git**.

```bash
git clone https://github.com/sbatra65-blip/rma-cloud.git
cd rma-cloud/apps/mobile
npm ci
npx cap sync ios
npx cap open ios          # opens Xcode
```

In Xcode:
1. Click **App** (left) → **Signing & Capabilities** → **Team**: sign in with your Apple ID (Xcode → Settings → Accounts). A free Apple ID works for your own phone.
2. If Xcode says the bundle ID is taken, change it to e.g. `com.trackmyrma.app.sanjay` (only for this test install).
3. Connect the iPhone with a cable → pick it at the top → press ▶ Run.
4. On the iPhone: Settings → General → **VPN & Device Management** → trust your Apple ID. Settings → Privacy & Security → **Developer Mode** → on (first time only).

With a free Apple ID the app works for 7 days on your own phone, then press Run again. To give it to others you need the App Store (below).

## 3. Later — publishing in the stores

| Store | Account | Cost | What to do |
|---|---|---|---|
| Google Play | Play Console (play.google.com/console) | $25 once | Make an upload key, build a signed **AAB** (`./gradlew bundleRelease` with the key), create the app listing, upload. |
| Apple App Store | Apple Developer Program | $99/year | In Xcode: Product → **Archive** → Distribute → App Store Connect. Create the listing in appstoreconnect.apple.com. |
| Microsoft Store | Partner Center (individual) | Free | Package as MSIX/APPX (`electron-builder --win appx`) and upload. |
| Mac | Same Apple Developer account | included | Sign + notarise the DMG (Developer ID), or submit to the Mac App Store. |

Store listings need: app name, short and long description, screenshots (phone and tablet sizes), privacy policy URL (`https://www.trackmyrma.com/privacy`), support email (`support@trackmyrma.com`), and a **demo login** for the reviewers — use a demo company, never real customer data.

Apple review note: the iPhone app shows the website. Apple accepts this when the app is useful as an app; ours uses the camera, photo library and the share sheet for Excel/ZIP/PDF files. If Apple asks for more, push notifications for RMA status changes are the natural next step.

Code signing (removes the Windows/Mac warnings) needs: Windows — a code-signing certificate; Mac — the Apple Developer account. Ask Claude to add them to the build once you have them; keys go into **GitHub → Settings → Secrets**, never into chat or the code.

## How the phone apps handle files
- Downloads (OEM Excel, bulk ZIP, PDFs, backups) are saved and the phone's **share sheet** opens: Save to Files, WhatsApp, Gmail, open in Excel.
- PDFs/photos linked from an RMA open the same way.
- Links to other websites open in the phone's browser.
- No internet → an offline page with "Try again".
