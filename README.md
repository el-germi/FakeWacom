# FakeWacom

Turn a phone or tablet into a drawing tablet for your Windows PC. Open a web page on the device and it shows a live view of the PC screen. Whatever you draw on it reaches Windows as a real Windows Ink pen, with pressure, tilt, eraser and barrel button.

Nothing needs installing on the device. Any browser with Pointer Events or Touch Events works, including IE11 on Windows RT.

## Requirements

- Windows 10 1809 or later (for synthetic pointer injection)
- [Node.js](https://nodejs.org/) 24 or later
- The PC and the device on the same network

## Install

```sh
git clone https://github.com/el-germi/FakeWacom.git
cd FakeWacom
npm install
```

## Usage

1. Start the server on the PC:

   ```sh
   npm start
   ```

   The first time it runs, Windows Firewall may ask whether to allow Node.js. Allow it on private networks.

2. The console prints the address to open, with a QR code for it, for example:

   ```
   Open the pad at http://192.168.1.9:3000/?token=1a2b3c...
   ```

   Scan the QR code with the tablet's camera, or type the URL. If the PC has several network adapters, the other candidate addresses are listed below it; if the first one doesn't load, try those.

3. Tap once. The first tap switches the page to fullscreen and is not sent to the PC. After that, draw.

On an iPhone, Safari can't make a page fullscreen. Use **Share → Add to Home Screen** and open it from there to run without the browser bars.

The token is generated on first run and saved to `.pad-token`. Anyone with the URL can control your pen and click on your PC, so keep it private. Delete `.pad-token` to get a new token.

## Configuration

Set these as environment variables before `npm start`:

| Variable             | Default   | Description                                                           |
| -------------------- | --------- | --------------------------------------------------------------------- |
| `PORT`               | `3000`    | HTTP port                                                             |
| `HOST`               | `0.0.0.0` | Address to listen on                                                  |
| `PAD_TOKEN`          | generated | Access token (overrides `.pad-token`)                                 |
| `PAD_AREA`           | `primary` | Screen area to show and draw on: `primary`, `all`, or `x,y,w,h` in px |
| `PAD_STREAM_WIDTH`   | `1280`    | Width of the streamed image in px (never upscaled)                    |
| `PAD_STREAM_QUALITY` | `60`      | JPEG quality, 1-100                                                   |
| `PAD_STREAM_FPS`     | `30`      | Maximum frames per second                                             |
| `TOUCH_LOG`          |           | Set to `1` to log every input event                                   |

For example, in Git Bash: `PAD_AREA=all npm start`.

## Limitations

- Windows only.
- Apps that only support WinTab, not Windows Ink, won't see the pen.
- One finger or pen draws at a time. Other touches, such as your palm, are ignored.
