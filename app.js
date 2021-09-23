const fs = require('fs');
const path = require('path');
const https = require('https');
const puppeteer = require('puppeteer');

(async () => {
  let userId = '';
  if (process.argv.length >= 3) {
    userId = process.argv[2];
  }
  if (!userId) return;

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: path.join(__dirname, 'profile'),
    // args: ['--proxy-server=127.0.0.1:7890']
  });

  const page = await browser.newPage();
  await page.goto(`https://${userId}.fanbox.cc`);
  const cookies = await page.cookies('https://fanbox.cc/');
  const cookieObj = {};
  for (let i = 0; i < cookies.length; i++) {
    const cookie = cookies[i];
    cookieObj[cookie.name] = cookie.value;
  }
  let cookieValue = '';
  for (let key in cookieObj) {
    if (cookieValue !== '') cookieValue += '; ';
    cookieValue += `${key}=${cookieObj[key]}`;
  }

  const list = await page.evaluate(async (id) => {
    try {
      return (await (await fetch(`https://api.fanbox.cc/post.listCreator?creatorId=${id}&limit=300`)).json()).body;
    } catch (e) {
      return null;
    }
  }, userId);
  if (list && list.items) {
    const dir = path.join(__dirname, 'data', userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const items = list.items;
    fs.writeFileSync(path.join(dir, `list.json`), JSON.stringify(items, null, 2));
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const jsonPath = path.join(dir, `${item.id}_${item.updatedDatetime.substr(0, 10)}.json`);
      let data = null;
      if (fs.existsSync(jsonPath)) {
        data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } else {
        data = await page.evaluate(async (id) => {
          try {
            return (await (await fetch(`https://api.fanbox.cc/post.info?postId=${id}`, {
              credentials: "include"
            })).json()).body;
          } catch (e) {
            return null;
          }
        }, item.id);
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
        await sleep(3 * 1000);
      }
      if (data) {
        if (data.body) {
          const textPath = path.join(dir, `${item.id}_${item.updatedDatetime.substr(0, 10)}_${item.title.replace(/[?\\\/\*|]/g, '')}.txt`);
          if (!fs.existsSync(textPath)) {
            // TEXT
            let text = '';
            if (data.type === 'video' && data.body.video) {
              if (data.body.video.serviceProvider === 'youtube') {
                text += `[https://www.youtube.com/watch?v=${data.body.video.videoId}]\n`;
              } else {
                console.log(`${item.id}: UNKNOWN VIDEO PROVIDER: ${data.body.video.serviceProvider}`);
              }
            }
            if (data.type === 'image' && data.body.images) {
              for (let key in data.body.images) {
                const image = data.body.images[key];
                text += `[image][${image.id}]\n`;
              }
            }
            if (data.body.text) {
              text += data.body.text;
            } else if (data.body.blocks) {
              for (let i = 0; i < data.body.blocks.length; i++) {
                const block = data.body.blocks[i];
                if (text != '') text += '\n';
                if (block.type === 'p' || block.type === 'header') {
                  text += block.text;
                } else if (block.type === 'image') {
                  text += `[${block.type}][${block.imageId}]`;
                } else if (block.type === 'file') {
                  text += `[${block.type}][${block.fileId}]`;
                } else if (block.type === 'embed') {
                  if (data.body.embedMap) {
                    const embed = data.body.embedMap[block.embedId];
                    if (embed) {
                      if (embed.serviceProvider === 'youtube') {
                        text += `[${block.type}][https://www.youtube.com/watch?v=${embed.contentId}]`;
                      } else if (embed.serviceProvider === 'twitter') {
                        text += `[${block.type}][https://twitter.com/user/status/${embed.contentId}]`;
                      } else if (embed.serviceProvider === 'fanbox') {
                        text += `[${block.type}][https://www.pixiv.net/fanbox/${embed.contentId}]`;
                      } else {
                        console.log(`${item.id}: UNKNOWN EMBED PROVIDER: ${embed.serviceProvider}`);
                      }
                    } else {
                      console.log(`${item.id}: UNKNOWN EMBED: ${block.embedId}`);
                    }
                  }
                } else {
                  text += `[${block.type}]`;
                  console.log(`${item.id}: UNKNOWN BLOCK TYPE: ${block.type}`);
                }
              }
            }
            fs.writeFileSync(textPath, text);
          }
          // IMAGE
          const images = data.body.images || data.body.imageMap;
          if (images) {
            for (let key in images) {
              const obj = images[key];
              const filePath = path.join(dir, `${item.id}_${obj.id}.${obj.extension}`);
              if (!fs.existsSync(filePath)) {
                const buffer = await rdownload(obj.originalUrl, cookieValue);
                fs.writeFileSync(filePath, buffer);
              }
            }
          }
          // FILE
          const files = data.body.files || data.body.fileMap;
          if (files) {
            for (let key in files) {
              const obj = files[key];
              const filePath = path.join(dir, `${item.id}_${obj.name}.${obj.extension}`);
              if (!fs.existsSync(filePath)) {
                const buffer = await rdownload(obj.url, cookieValue);
                fs.writeFileSync(filePath, buffer);
              }
            }
          }
        } else {
          fs.unlinkSync(jsonPath);
          console.log(`${item.id}: NO DATA BODY: ${item.feeRequired}_${item.title}`);
        }
      } else {
        console.log(`${item.id}: NO DATA`);
      }
      // COVER
      if (data.coverImageUrl) {
        const extname = path.extname(data.coverImageUrl);
        const filePath = path.join(dir, `${item.id}_cover${extname}`);
        if (!fs.existsSync(filePath)) {
          const buffer = await rdownload(data.coverImageUrl);
          fs.writeFileSync(filePath, buffer);
        }
      }
    }
  }
  await page.close();
  await browser.close();
})();

function sleep(timeout) {
  return new Promise(resolve => {
    setTimeout(resolve, timeout);
  });
}

async function rdownload(url, cookie) {
  while (true) {
    try {
      return await download(url, cookie);
    } catch (e) {
      console.log(e.message);
    }
  }
}

function download(url, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        'accept': '*/*',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'ja',
        'cookie': cookie || null,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.150 Safari/537.36 Edg/88.0.705.63'
      }
    }, (res) => {
      if (res.statusCode === 200) {
        const arr = [];
        res.on('data', (chunk) => {
          arr.push(chunk);
        });
        res.on('end', () => {
          resolve(Buffer.concat(arr));
        });
      } else {
        reject(new Error(`STATUSCODE: ${res.statusCode}`));
      }
    });
    req.on('error', (e) => {
      reject(e);
    });
    req.end();
  });
};
