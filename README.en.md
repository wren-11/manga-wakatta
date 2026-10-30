# MangaWakatta!

[中文](README.md)

A Chrome extension that screenshots the manga you're reading, finds the speech bubbles and lays the translation over them. Translates into English, Simplified Chinese or Traditional Chinese.

It's made for online manga readers such as honto and ebookjapan. Because it reads the screen rather than the image files, it works even in official readers that won't let you save pages.

## Install

1. [Download the ZIP](https://github.com/wren-11/manga-wakatta/archive/refs/heads/main.zip), unzip it, and keep the `manga-wakatta-main` folder somewhere safe.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder.

To update, unzip the new version over the old folder and hit the reload button on the extension in `chrome://extensions`.

## Get an API key

Pick one:

- **Qwen** (Alibaba Cloud): cheap, with a free quota in some regions.
- **Claude**: the best results, pay as you go.

### Qwen

1. Sign in to [Alibaba Cloud Model Studio](https://bailian.console.aliyun.com).
2. Switch the region at the top of the console to the one nearest you. Speed depends on distance: from outside China, the Beijing region takes 10–20 seconds a page, while a nearby region (Singapore, if you're in Australia or Southeast Asia) takes about 5.
3. Click "API-KEY" at the bottom left, create a key and copy it. Also copy the Base URL labelled "OpenAI 兼容地址" (OpenAI compatible).
4. Right-click the extension icon → **Options**, choose Qwen, paste the key and Base URL, and save.

New accounts on aliyun.com get a free quota in the Beijing region only. Other regions cost well under a US cent per screen. According to Alibaba, new accounts on [alibabacloud.com](https://www.alibabacloud.com) get a free quota in Singapore.
If you use a free quota, open `qwen3-vl-plus` under Models and switch on "免费额度用完即停" (stop when the free quota runs out) so you're never billed. It's off by default.

**Checking your free quota:** in the console, go to Models, search for `qwen3-vl-plus` and open it. The "免费额度" (free quota) section shows how many tokens are left and when they expire. A screen (two pages) uses about 8,000 tokens.

**After the free quota runs out:** top up your Alibaba Cloud account, then go back to the `qwen3-vl-plus` page and switch off "免费额度用完即停". Your key and the extension's settings stay the same. From then on you pay per use, and if your balance hits zero the account goes into arrears, so keep a little credit in it.

### Claude

1. Sign in to [platform.claude.com](https://platform.claude.com) and add credit under Billing. On Claude Max or Team, you can use your monthly API credit instead by linking it under Settings → Billing → API credits on claude.ai.
2. Create a key under API Keys and copy it.
3. Right-click the extension icon → **Options**, choose Claude, paste the key and save.

Your key stays in your browser. Don't share it.

## Use

Settings take effect as soon as you save, no reload needed. If your manga tab was open before you installed the extension, refresh it first.

Open a manga and click the extension icon, or press `Option + T` (`Alt + T` on Windows).

- New pages are translated automatically. You can turn this off in Options.
- A page you've already translated isn't charged again.
- Change the shortcut at `chrome://extensions/shortcuts`.

If you use a page translator such as Immersive Translate, set it to never translate your manga site, or it will translate the translations.

## Settings

- **Translate to**: English / Simplified Chinese / Traditional Chinese
- **Translation boxes**: "Cover the original text only" leaves the art alone. "Grow" is easier to read but covers more art.
- **Maximum text size**: small / medium / large
- **Translate automatically after turning the page**: on by default

## Troubleshooting

- **Nothing happens**: it can't run on `chrome://` pages. If you just installed it, reload the manga page.
- **Invalid key**: check it was copied in full. For Qwen, the key and Base URL must be from the same region.
- **Out of credit**: top up your account, or for Qwen, switch back to a region with free quota.
- **Boxes in the wrong spot**: the model sometimes puts a box in slightly the wrong place. Claude does better.

## Known issues

- Translations sit in white boxes over the original. The original isn't erased.
- Now and then a line gets skipped or a box lands in the wrong spot.
- Only what's visible in the window is translated.

## Plans and feedback

Planned: [Korean and Chinese comics](https://github.com/wren-11/manga-wakatta/issues/1), [auto-translate for vertical-scroll webtoons](https://github.com/wren-11/manga-wakatta/issues/2), and a [retranslate button](https://github.com/wren-11/manga-wakatta/issues/3). Comment or add a 👍 on the ones you want. Found a bug? Open an [issue](https://github.com/wren-11/manga-wakatta/issues).

## Privacy

Screenshots go only to the AI service you pick. The extension has no server.

## License

[MIT](LICENSE)
