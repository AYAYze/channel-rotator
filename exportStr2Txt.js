import fs from "fs/promises";
import path from "path";

/**
 * @param {string} content  저장할 문자열
 * @param {string} filePath 저장할 파일 경로
 */

export async function exportStr2Txt(content, filePath) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
}
