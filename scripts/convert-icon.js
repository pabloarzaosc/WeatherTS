import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve();
const pngPath = path.join(projectRoot, 'we_blue_transparent_2048.png');
const buildDir = path.join(projectRoot, 'build');
const icoPath = path.join(buildDir, 'icon.ico');
const pngOutPath = path.join(buildDir, 'icon.png');

if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

if (!fs.existsSync(pngPath)) {
  console.error('PNG file not found:', pngPath);
  process.exit(1);
}

const pngData = fs.readFileSync(pngPath);
fs.writeFileSync(pngOutPath, pngData);

// Basic ICO header for a single PNG image (size 256x256)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = ICO
header.writeUInt16LE(1, 4); // count = 1

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // width (0 = 256)
entry.writeUInt8(0, 1); // height (0 = 256)
entry.writeUInt8(0, 2); // color count
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(pngData.length, 8); // size
entry.writeUInt32LE(22, 12); // offset

const icoData = Buffer.concat([header, entry, pngData]);
fs.writeFileSync(icoPath, icoData);

console.log('Successfully created build/icon.ico and build/icon.png');
