/*
 * Project: mediac
 * Created: 2024-04-20 18:07:23
 * Modified: 2024-04-20 18:07:23
 * Author: mcxiaoke (github@mcxiaoke.com)
 * License: Apache License 2.0
 */

import { execa } from 'execa'
import fs from 'fs'
import path from 'path'
import { getMediaInfo } from '../lib/ffprobe.js' // 导入您之前定义的解析器函数
import * as helper from '../lib/helper.js'

// 递归遍历目录，找到所有音视频文件
function findMediaFiles(directory, mediaFiles = []) {
    const files = fs.readdirSync(directory)

    files.forEach(file => {
        const filePath = path.join(directory, file)
        const stat = fs.statSync(filePath)

        if (stat.isDirectory()) {
            // 递归遍历子目录
            findMediaFiles(filePath, mediaFiles)
        } else {
            // 检查文件扩展名是否为音视频格式
            if (helper.isMediaFile(filePath)) {
                mediaFiles.push(filePath)
            }
        }
    })

    return mediaFiles
}

// 递归遍历目录，找到所有音视频文件，并获取其信息
async function showMediaFilesInfo(directory) {
    const mediaFiles = findMediaFiles(directory)

    for (const filePath of mediaFiles) {
        const mediaInfo = await getMediaInfo(filePath)
        console.log(mediaInfo?.format)
    }

}

// 示例用法
await showMediaFilesInfo(process.argv[2])