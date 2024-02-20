#!/usr/bin/env node
import assert from "assert";
import dayjs from "dayjs";
import inquirer from "inquirer";
import throat from 'throat';
import pMap from 'p-map';
import sharp from "sharp";
import path from "path";
import fs from 'fs-extra';
import chalk from 'chalk';
import yargs from "yargs";
import PrettyError from 'pretty-error';
import { cpus, tmpdir } from "os";

import * as log from '../lib/debug.js'
import * as exif from '../lib/exif.js'
import * as helper from '../lib/helper.js'
import * as mf from '../lib/file.js'

const cpuCount = cpus().length;
// debug and logging config
// 配置错误信息输出
const prettyError = PrettyError.start();
prettyError.skipNodeFiles();
// 配置调试等级
const configCli = (argv) => {
  // log.setName("MediaCli");
  log.setLevel(argv.verbose);
  log.debug(argv);
};
// 日志文件
const fileLog = function (msg, tag) {
  log.fileLog(msg, tag, "mediac");
}

// 命令行参数解析
const ya = yargs(process.argv.slice(2));
// https://github.com/yargs/yargs/blob/master/docs/advanced.md
ya
  .usage("Usage: $0 <command> <input> [options]")
  .positional("input", {
    describe: "Input folder that contains files",
    type: "string",
    normalize: true,
  })
  // 测试命令，无作用
  .command(
    ["test", "tt", "$0"],
    "Test command, do nothing",
    (ya) => {
      // yargs.option("output", {
      //   alias: "o",
      //   type: "string",
      //   normalize: true,
      //   description: "Output folder",
      // });
    },
    (argv) => {
      ya.showHelp();
    }
  )
  // 命令：重命名
  // 默认按照EXIF拍摄日期重命名，可提供自定义模板
  .command(
    ["rename <input> [options]", "rn"],
    "Rename media files in input dir by exif date",
    (ya) => {
      ya
        .option("backup", {
          // 备份原石文件
          alias: "b",
          type: "boolean",
          default: false,
          description: "backup original file before rename",
        })
        .option("fast", {
          // 快速模式，使用文件修改时间，不解析EXIF
          alias: "f",
          type: "boolean",
          description: "fast mode (use file modified time, no exif parse)",
        })
        .option("prefix", {
          // 重命名后的文件前缀
          alias: "p",
          type: "string",
          default: "IMG_/DSC_/VID_",
          description: "custom filename prefix for raw/image/video files'",
        })
        .option("suffix", {
          // 重命名后的后缀
          alias: "s",
          type: "string",
          default: "",
          description: "custom filename suffix",
        })
        .option("template", {
          // 文件名模板，使用dayjs日期格式
          alias: "t",
          type: "string",
          default: "YYYYMMDD_HHmmss",
          description:
            "filename date format template, see https://day.js.org/docs/en/display/format",
        });
    },
    (argv) => {
      cmdRename(argv);
    }
  )
  // 命令 文件名规范化
  // 去除文件名中的特殊字符和非法字符，仅保留ASCII和CJK字符
  // 可自定义要去掉的字符和字符串
  // TODO
  .command(
    ["normalize <input>", "nz"],
    "Normalize file names according given rules",
    (ya) => {
      ya.option("chars", {
        // 需要从文件名中清除的字符列表
        alias: "c",
        type: "string",
        description: "Delete chars(in given string) from filename",
      })
        .option("words", {
          // 需要从文件名中清除的单词列表，逗号分割
          alias: "w",
          type: "string",
          description: "Delete words(multi words seperated by comma) from filename",
        })
    },
    (argv) => {
      cmdNormalize(argv);
    }
  )
  // 命令 分类图片文件
  // 按照文件类型，图片或视频，分类整理
  // 按照EXIF拍摄日期的年份和月份整理图片
  .command(
    ["organize <input> [output]", "oz"],
    "Organize pictures by file modified date",
    (ya) => {
      // yargs.option("output", {
      //   alias: "o",
      //   type: "string",
      //   normalize: true,
      //   description: "Output folder",
      // });
    },
    (argv) => {
      cmdOrganize(argv);
    }
  )
  // 命令 LR输出文件移动
  // 移动RAW目录下LR输出的JPEG目录到单独的图片目录
  .command(
    ["lrmove <input> [output]", "lv"],
    "Move JPEG output of RAW files to other folder",
    (ya) => {
      // yargs.option("output", {
      //   alias: "o",
      //   type: "string",
      //   normalize: true,
      //   description: "Output folder",
      // });
    },
    (argv) => {
      cmdLRMove(argv);
    }
  )
  // 命令 生成缩略图
  // 生成指定大小的缩略图，可指定最大边长
  .command(
    ["thumbs <input> [output]", "tb"],
    "Make thumbs for input images",
    (ya) => {
      ya
        // .option("output", {
        //   alias: "o",
        //   type: "string",
        //   normalize: true,
        //   description: "Output folder",
        // })
        .option("force", {
          alias: "f",
          type: "boolean",
          description: "Force to override existing thumb files",
        })
        .option("max", {
          alias: "m",
          type: "number",
          description: "Max size of long side of image thumb",
        });
    },
    (argv) => {
      cmdThumbs(argv);
    }
  )
  // 命令 压缩图片
  // 压缩满足条件的图片，可指定最大边长和文件大小，输出质量
  // 可选删除压缩后的源文件
  .command(
    ["compress <input> [output]", "cs"],
    "Compress input images to target size",
    (ya) => {
      ya
        .option("delete", {
          alias: "d",
          type: "boolean",
          default: false,
          description: "Delete original image file",
        })
        .option("quality", {
          alias: "q",
          type: "number",
          default: 88,
          description: "Target image file compress quality",
        })
        .option("size", {
          alias: "s",
          type: "number",
          default: 2048,
          description: "Processing file bigger than this size (unit:k)",
        })
        .option("width", {
          alias: "w",
          type: "number",
          default: 6000,
          description: "Max width of long side of image thumb",
        });
    },
    (argv) => {
      cmdCompress(argv);
    }
  )
  // 命令 删除图片
  // 按照指定规则删除文件，条件包括宽度高度、文件大小、文件名规则
  // 支持严格模式和宽松模式
  .command(
    ["remove <input> [output]", "rm"],
    "Remove files by given size/width-height/name-pattern/file-list",
    (ya) => {
      ya
        .option("safe", {
          type: "boolean",
          default: true,
          // 使用安全删除，默认开启，移动到Deleted目录，关闭后是永久删除
          description: "If true, moved to Deleted dir, instead real delete",
        })
        .option("loose", {
          alias: "l",
          type: "boolean",
          default: false,
          // 宽松模式，默认不开启，宽松模式条件或，默认严格模式条件与
          description: "If true, operation of conditions is OR, default AND",
        })
        .option("width", {
          type: "number",
          default: 0,
          // 图片文件的最大宽度
          description: "Files width smaller than value will be removed",
        })
        .option("height", {
          type: "number",
          default: 0,
          // 图片文件的最大高度
          description: "Files height smaller than value will be removed",
        })
        .option("dimension", {
          alias: "d",
          type: "string",
          default: "",
          // 图片文件的长宽字符串形式
          description: "File dimension, width and height, eg: '123x456'",
        })
        .option("size", {
          alias: "s",
          type: "number",
          default: 0,
          // 图片文件的文件大小数值，最大，单位为k
          description: "Files size smaller than value will be removed (unit:k)",
        })
        .option("pattern", {
          alias: "p",
          type: "string",
          default: "",
          // 文件名匹配，字符串或正则表达式
          description: "Files name pattern matche value will be removed",
        })
        .option("list", {
          type: "string",
          default: null,
          // 文件名列表文本文件，或者一个目录，里面包含的文件作为文件名列表来源
          description: "File name list file, or dir contains files for file name",
        })
        .option("reverse", {
          alias: "r",
          type: "boolean",
          default: false,
          // 文件名列表反转，默认为否，即删除列表中的文件，反转则删除不在列表中的文件
          description: "delete files in list, if true delete files not in the list",
        });
    },
    (argv) => {
      cmdRemove(argv);
    }
  )
  // 命令 向上移动文件
  // 把多层嵌套目录下的文件移动到顶层目录，按图片和视频分类
  .command(
    ["moveup <input> [output]", "mu"],
    "Move files to sub folder in top folder",
    (ya) => {
      ya
        .option("output", {
          alias: "o",
          type: "string",
          normalize: true,
          description: "Output sub folder name",
        });
    },
    (argv) => {
      cmdMoveUp(argv);
    }
  )
  // 命令 重命名文件
  // 按照规则，将多个上级目录的名字附加到文件名，防止文件名冲突
  .command(
    ["prefix <input> [output]", "px"],
    "Rename files by append dir name or fixed string",
    (ya) => {
      ya.option("size", {
        alias: "s",
        type: "number",
        default: 24,
        description: "size[length] of prefix of dir name",
      })
        .option("ignore", {
          alias: "i",
          type: "string",
          description: "ignore string of prefix of dir name",
        })
        .option("prefix", {
          alias: "p",
          type: "string",
          description: "filename prefix for output ",
        })
        .option("all", {
          alias: "a",
          type: "boolean",
          description: "force rename all files ",
        })
    },
    (argv) => {
      cmdPrefix(argv);
    }
  )
  .count("verbose")
  .alias("v", "verbose")
  .alias("h", "help")
  .epilog(
    "Media Utilities: Process Image/Raw/Video files by EXIF date tags\nCopyright 2021-2023 @ Zhang Xiaoke"
  )
  .demandCommand(1, chalk.red("Missing sub command you want to execute!"))
  .showHelpOnFail()
  .help()
  .middleware([configCli]);
const yargv = ya.argv;

// 这个函数是一个异步函数，用于重命名文件  
async function renameFiles(files) {
  // 打印日志信息，显示要重命名的文件总数  
  log.info("Rename", `total ${files.length} files`);

  // 使用 Promise.all 方法异步处理所有文件  
  // rename all files  
  return await Promise.all(
    files.map(async (f) => {
      // 生成输出文件的路径  
      const outPath = path.join(path.dirname(f.path), f.outName);

      // 如果输出文件名不存在或者输入文件路径等于输出文件路径，忽略该文件并打印警告信息  
      if (!f.outName || f.path == f.outPath) {
        log.showYellow("Rename", "ignore", f.path);
        return;
      }

      try {
        // 使用 fs 模块的 rename 方法重命名文件，并等待操作完成  
        await fs.rename(f.path, outPath);

        // 打印重命名成功的日志信息，显示输出文件的路径  
        log.show(chalk.green(`Renamed:`) + ` ${outPath}`);
        return f;
      } catch (error) {
        // 捕获并打印重命名过程中出现的错误信息，显示错误原因和输入文件的路径  
        log.error("Rename", error, f.path);
      }
    })
  );
}

async function cmdPrefix(argv) {
  log.show('cmdPrefix', argv);
  const root = path.resolve(argv.input);
  if (!root || !(await fs.pathExists(root))) {
    yargs.showHelp();
    log.error(`Invalid Input: '${root}'`);
    return;
  }
  const fastMode = argv.fast || false;
  const allMode = argv.all || false;
  const startMs = Date.now();
  log.show("Prefix", `Input: ${root}`, fastMode ? "(FastMode)" : "");
  let files = await mf.walk(root, {
    entryFilter: (entry) =>
      entry.stats.isFile() &&
      entry.stats.size > 1024
  });
  // process only image files
  // files = files.filter(x => helper.isImageFile(x.path));
  files.sort();
  log.show("Prefix", `Total ${files.length} files found`);
  if (files.length == 0) {
    log.showYellow("Prefix", "Nothing to do, exit now.");
    return;
  }
  //let nameIndex = 0;
  // 正则：仅包含数字
  const reOnlyNum = /^\d+$/;
  // 正则：匹配除 中日韩俄英 之外的特殊字符
  const reNonChars = /[^\p{sc=Hani}\p{sc=Hira}\p{sc=Kana}\p{sc=Hang}\p{sc=Cyrl}\w_]/ugi;
  const tasks = [];
  for (const f of files) {
    const [dir, base, ext] = helper.pathSplit(f.path);
    if (!reOnlyNum.test(base) && !allMode) {
      log.showYellow("Prefix", `Ignore: ${helper.pathShort(f.path)}`);
      continue;
    }
    // 取目录项的最后两级目录名
    let dirFix = dir.split(path.sep).slice(-2).join("_");
    // 去掉目录名中的年月日
    let dirStr = dirFix.replaceAll(/\d{4}-\d{2}-\d{2}/gi, "");
    dirStr = dirStr.replaceAll(/\d+年\d+月/gi, "");
    // 去掉附加说明
    dirStr = dirStr.replaceAll(/\[.+\]/gi, "");
    dirStr = dirStr.replaceAll(/\(.+\)/gi, "");
    dirStr = dirStr.replaceAll(/\d+P(\d+V)?/gi, "");
    // 去掉所有特殊字符
    dirStr = dirStr.replaceAll(reNonChars, "");
    if (argv.ignore && argv.ignore.length >= 2) {
      dirStr = dirStr.replaceAll(argv.ignore, "");
    } else {
      dirStr = dirStr.replaceAll(/更新|合集|画师|图片|视频|插画|视图|订阅|限定|差分|R18|PSD|PIXIV|PIC|NO|ZIP|RAR/gi, "");
    }
    const nameSlice = (argv.size || 24) * -1;
    // 去掉所有特殊字符
    let oldBase = base.replaceAll(reNonChars, "");
    //oldBase = oldBase.replaceAll(/\s/gi, "").slice(nameSlice);
    const fPrefix = (dirStr + "_" + oldBase).slice(nameSlice);
    const newName = `${fPrefix}${ext}`;
    const newPath = path.join(dir, newName);
    f.outName = newName;
    log.show("Prefix", `Output: ${helper.pathShort(newPath)}`);
    tasks.push(f);
  }
  if (tasks.length > 0) {
    log.showGreen(
      "Prefix",
      `Total ${files.length} media files ready to rename`,
      allMode ? "(allMode)" : ""
    );
  } else {
    log.showYellow(
      "Prefix",
      `Nothing to do, abort.`,
      allMode ? "(allMode)" : ""
    );
    return;
  }

  const answer = await inquirer.prompt([
    {
      type: "confirm",
      name: "yes",
      default: false,
      message: chalk.bold.red(
        `Are you sure to rename ${tasks.length} files?` +
        (allMode ? " (allMode)" : "")
      ),
    },
  ]);
  if (answer.yes) {
    renameFiles(tasks).then((tasks) => {
      log.showGreen("Prefix", `There ${tasks.length} file were renamed.`);
    });
  } else {
    log.showYellow("Prefix", "Will do nothing, aborted by user.");
  }
}

async function cmdRename(argv) {
  log.show('cmdRename', argv);
  const root = path.resolve(argv.input);
  if (!root || !(await fs.pathExists(root))) {
    yargs.showHelp();
    log.error(`Invalid Input: '${root}'`);
    return;
  }
  const fastMode = argv.fast || false;
  // action: rename media file by exif date
  const startMs = Date.now();
  log.show("Rename", `Input: ${root}`, fastMode ? "(FastMode)" : "");
  let files = await exif.listMedia(root);
  const filesCount = files.length;
  log.show("Rename", `Total ${files.length} media files found`);
  files = await exif.parseFiles(files, { fastMode: fastMode });
  log.show(
    "Rename",
    `Total ${files.length} media files parsed`,
    fastMode ? "(FastMode)" : ""
  );
  files = exif.buildNames(files);
  const [validFiles, skippedBySize, skippedByDate] = exif.checkFiles(files);
  files = validFiles;
  if (filesCount - files.length > 0) {
    log.warn(
      "Rename",
      `Total ${filesCount - files.length} media files skipped`
    );
  }
  log.show(
    "Rename",
    `Total ${filesCount} files processed in ${helper.humanTime(startMs)}`,
    fastMode ? "(FastMode)" : ""
  );
  if (skippedBySize.length > 0) {
    log.showYellow(
      "Rename",
      `Total ${skippedBySize.length} media files are skipped by size`
    );
  }
  if (skippedByDate.length > 0) {
    log.showYellow(
      "Rename",
      `Total ${skippedByDate.length} media files are skipped by date`
    );
  }
  if (files.length == 0) {
    log.showYellow("Rename", "Nothing to do, exit now.");
    return;
  }
  log.show(
    "Rename",
    `Total ${files.length} media files ready to rename`,
    fastMode ? "(FastMode)" : ""
  );
  const answer = await inquirer.prompt([
    {
      type: "confirm",
      name: "yes",
      default: false,
      message: chalk.bold.red(
        `Are you sure to rename ${files.length} files?` +
        (fastMode ? " (FastMode)" : "")
      ),
    },
  ]);
  if (answer.yes) {
    renameFiles(files).then((files) => {
      log.showGreen("Rename", `There ${files.length} file were renamed.`);
    });
  } else {
    log.showYellow("Rename", "Will do nothing, aborted by user.");
  }
}

async function cmdNormalize(argv) {
  // todo
}

async function cmdMoveUp(argv) {
  log.show('cmdMoveUp', argv);
  const root = path.resolve(argv.input);
  if (!root || !(await fs.pathExists(root))) {
    yargs.showHelp();
    log.error("MoveUp", `Invalid Input: '${root}'`);
    return;
  }
  // 读取顶级目录下所有的子目录
  const outputDirName = argv.output || "图片";
  const videoDirName = "视频"
  let subDirs = await fs.readdir(root, { withFileTypes: true });
  subDirs = subDirs.filter(x => x.isDirectory()).map(x => x.name);
  log.show("MoveUp", "Folders:", subDirs)

  const answer = await inquirer.prompt([
    {
      type: "confirm",
      name: "yes",
      default: false,
      message: chalk.bold.red(
        `Are you sure to move files in these folders to top sub folder?`
      ),
    },
  ]);
  if (!answer.yes) {
    log.showYellow("MoveUp", "Will do nothing, aborted by user.");
    return;
  }

  // 移动各个子目录的文件到 子目录/图片 目录
  let movedCount = 0;
  for (const subDir of subDirs) {
    let curDir = path.join(root, subDir)
    let files = await exif.listMedia(curDir)
    log.show("MoveUp", `Total ${files.length} media files found in ${subDir}`);
    const fileOutput = path.join(curDir, outputDirName)
    const videoOutput = path.join(curDir, videoDirName);
    log.show("MoveUp", `fileOutput = ${fileOutput}`);
    for (const f of files) {
      const fileSrc = f.path;
      let fileDst = path.join(helper.isVideoFile(fileSrc) ? videoOutput : fileOutput, path.basename(fileSrc));
      if (fileSrc === fileDst) {
        log.info("Skip Same:", fileDst);
        continue;
      }
      if (!(await fs.pathExists(fileSrc))) {
        log.showYellow("Not Found:", fileSrc);
        continue;
      }
      if (await fs.pathExists(fileDst)) {
        const stSrc = await fs.stat(fileSrc);
        const stDst = await fs.stat(fileDst);
        if (stSrc.size !== stDst.size) {
          // same name ,but not same file
          const [dstDir, dstBase, dstExt] = helper.pathSplit(fileDst);
          fileDst = path.join(dstDir, `${dstBase}_1${dstExt}`);
          log.showYellow("New Name:", fileDst);
        }
      }
      if (await fs.pathExists(fileDst)) {
        log.showYellow("Skip Exists:", fileDst);
        continue;
      }
      if (!(await fs.pathExists(fileOutput))) {
        await fs.mkdirp(fileOutput);
      }
      try {
        await fs.move(fileSrc, fileDst);
        // movedFiles.push([fileSrc, fileDst]);
        movedCount++;
        log.info("Moved:", fileSrc, "to", fileDst);
      } catch (error) {
        log.error("Failed:", error, fileSrc, "to", fileDst);
      }
    }
    log.showGreen("MoveUp", `Files in ${curDir} are moved to ${fileOutput}.`);
  };
  log.showGreen("MoveUp", `All ${movedCount} files moved.`);
}

async function cmdOrganize(argv) {
  log.show('cmdOrganize', argv);
  const root = path.resolve(argv.input);
  if (!root || !(await fs.pathExists(root))) {
    yargs.showHelp();
    log.error("Organize", `Invalid Input: '${root}'`);
    return;
  }
  const output = argv.output || root;
  // rules:
  // 1. into folders by file type (png/video/image)
  // 2. into folders by date month
  log.show(`Organize: input:`, root);
  log.show(`Organize: output:`, output);
  let files = await exif.listMedia(root);
  log.show("Organize", `Total ${files.length} media files found`);
  const pics = {};
  files.forEach((f, i) => {
    log.debug(`Processing(${i}):`, path.basename(f.path), f.stats.mtime);
    if ([".png", ".gif"].includes(helper.pathExt(f.path, true))) {
      if (!pics["pngs"]) {
        pics["pngs"] = [];
      }
      pics["pngs"].push(f);
      log.debug("PNG Item:", f.path);
    } else if (
      f.stats.size < 1000 * 1024 &&
      helper.pathExt(f.path, true) === ".jpg"
    ) {
      if (!pics["pngs"]) {
        pics["pngs"] = [];
      }
      pics["pngs"].push(f);
      log.debug("Other Item:", f.path, helper.fileSizeSI(f.stats.size));
    } else {
      let dirName;
      const dateStr = dayjs(f.stats.mtime).format("YYYYMM");;
      if (helper.isVideoFile(f.path)) {
        dirName = path.join("vids", dateStr);
      } else {
        dirName = dateStr;
      }
      if (!pics[dirName]) {
        pics[dirName] = [];
      }
      pics[dirName].push(f);
      log.debug("Image Item:", f.path, dirName);
    }
  });
  for (const [k, v] of Object.entries(pics)) {
    if (v.length > 0) {
      log.show(
        `Organize:`,
        `${v.length} files will be moved to '${path.join(output, k)}'`
      );
    }
  }
  const answer = await inquirer.prompt([
    {
      type: "confirm",
      name: "yes",
      default: false,
      message: chalk.bold.red(
        `Are you sure to move these ${files.length} files?`
      ),
    },
  ]);
  if (answer.yes) {
    for (const [k, v] of Object.entries(pics)) {
      if (v.length > 0) {
        const movedFiles = [];
        const fileOutput = path.join(output, k);
        for (const f of v) {
          const fileSrc = f.path;
          const fileDst = path.join(fileOutput, path.basename(fileSrc));
          if (!(await fs.pathExists(fileSrc))) {
            log.info("Not Found:", fileSrc);
            continue;
          }
          if (await fs.pathExists(fileDst)) {
            log.info("Skip Exists:", fileDst);
            continue;
          }
          if (!(await fs.pathExists(fileOutput))) {
            await fs.mkdirp(fileOutput);
          }
          try {
            await fs.move(fileSrc, fileDst);
            movedFiles.push([fileSrc, fileDst]);
            log.info("Moved:", fileSrc, "to", fileDst);
          } catch (error) {
            log.error("Failed:", error, fileSrc, "to", fileDst);
          }
        }
        if (v.length - movedFiles.length > 0) {
          log.showYellow(
            `Skipped:`,
            `${v.length - movedFiles.length
            } files are already in '${fileOutput}'`
          );
        }
        if (movedFiles.length > 0) {
          log.showGreen(
            `Done:`,
            `${movedFiles.length} files are moved to '${fileOutput}'`
          );
        }
      }
    }
  } else {
    log.showYellow("Will do nothing, aborted by user.");
  }
}

async function cmdLRMove(argv) {
  log.show('cmdLRMove', argv);
  const root = path.resolve(argv.input);
  if (!root || !(await fs.pathExists(root))) {
    yargs.showHelp();
    log.error("LRMove", `Invalid Input: '${root}'`);
    return;
  }
  // const output = argv.output || root;
  log.show(`LRMove: input:`, root);
  // log.show(`LRMove: output:`, output);
  let filenames = await mf.walkDir(root);
  filenames = filenames.filter(f => path.basename(f) === "JPEG");
  log.show("LRMove:", `Total ${filenames.length} JPEG folders found`);
  if (filenames.length == 0) {
    log.showGreen("Nothing to do, abort.");
    return;
  }
  const files = filenames.map(f => {
    const fileSrc = f;
    const fileBase = path.dirname(fileSrc);
    const fileDst = fileBase.replace("RAW" + path.sep, "JPEG" + path.sep);
    const task = {
      fileSrc: fileSrc,
      fileDst: fileDst
    }
    log.show(`SRC:`, fileSrc);
    log.show("DST:", fileDst);
    return task;
  })
  const answer = await inquirer.prompt([
    {
      type: "confirm",
      name: "yes",
      default: false,
      message: chalk.bold.red(
        `Are you sure to move these ${files.length} JPEG folder with files?`
      ),
    },
  ]);
  if (answer.yes) {
    for (const f of files) {
      try {
        await fs.move(f.fileSrc, f.fileDst);
        log.showGreen("Moved:", f.fileSrc, "to", f.fileDst);
      } catch (error) {
        log.error("Failed:", error, f.fileSrc, "to", f.fileDst);
      }
    }
  } else {
    log.showYellow("Will do nothing, aborted by user.");
  }
}

// 文心一言注释
// 准备缩略图参数的异步函数  
async function prepareThumbArgs(f, options) {
  // 默认选项为空对象  
  options = options || {};
  // 最大尺寸，默认为3000  
  const maxSize = options.maxSize || 3000;
  // 是否强制，默认为false  
  const force = options.force || false;
  // 输出路径，默认为undefined  
  const output = options.output || undefined;
  // 文件源路径，解析后  
  let fileSrc = path.resolve(f.path);
  // 使用helper.pathSplit分割路径，得到目录、基本名称和扩展名  
  const [dir, base, ext] = helper.pathSplit(fileSrc);
  // 文件目标路径  
  let fileDst;
  // 目录目标路径  
  let dirDst;
  // 如果output存在，使用output重写目录目标路径  
  if (output) {
    dirDst = helper.pathRewrite(dir, output);
  } else {
    // 否则，将目录目标路径替换为'Thumbs'文件夹，或者如果目录目标路径和目录相同，则创建一个新目录（例如'202206_thumbs'）  
    dirDst = dir.replace(/JPEG|Photos/i, 'Thumbs');
    if (dirDst == dir) {
      dirDst = path.join(path.dirname(dir), path.basename(dir) + '_thumbs');
    }
  }
  // 将目录目标路径中的'相机照片'替换为'相机小图'  
  dirDst = dirDst.replace('相机照片', '相机小图');
  // 文件目标路径，加入新的基本名称和扩展名（例如'_thumb.jpg'）  
  fileDst = path.join(dirDst, `${base}_thumb.jpg`);
  // 解析文件源路径和文件目标路径为绝对路径  
  fileSrc = path.resolve(fileSrc);
  fileDst = path.resolve(fileDst);

  // 检查文件目标路径是否存在，如果存在并且不强制执行，则返回空对象；否则，如果强制执行，则继续执行下面的代码块  
  if (await fs.pathExists(fileDst)) {
    log.info("prepareThumbArgs exists:", fileDst, force ? "(Override)" : "");
    if (!force) {
      return;
    }
  }
  try {
    // 使用sharp库创建图像对象，并传入文件源路径  
    const s = sharp(fileSrc);
    // 获取图像元数据对象，并等待操作完成  
    const m = await s.metadata();
    // 如果图像宽度和高度都小于等于最大尺寸，则打印调试信息并返回空对象；否则，继续执行下面的代码块  
    if (m.width <= maxSize && m.height <= maxSize) {
      log.debug("prepareThumbArgs skip:", fileSrc);
      return;
    }
    // 根据图像宽度和高度计算新的宽度和高度，使宽度不超过最大尺寸，并保持高度比例不变  
    const nw = m.width > m.height ? maxSize : Math.round((maxSize * m.width) / m.height);
    const nh = Math.round((nw * m.height) / m.width);
    // 打印信息，显示文件目标路径、原始尺寸和新尺寸（例如'F:\Temp\照片\202206_thumbs\202206_thumb.jpg (3072x2048 => 300x200)'）  
    log.info("prepareThumbArgs add:", fileDst, `(${m.width}x${m.height} => ${nw}x${nh})`);
    // 返回一个对象，包含新尺寸、文件源路径和文件目标路径等属性，同时包含索引属性（如果原始对象存在）  
    return { width: nw, height: nh, src: fileSrc, dst: fileDst, index: f.index };
  } catch (error) {
    log.error("prepareThumbArgs error:", error, f.path);
  }
}

// 文心一言注释
// 这是一个异步函数，用于创建缩略图  
async function makeThumbOne(t) {
  // 试图确保目标文件目录存在，如果不存在则创建  
  try {
    await fs.ensureDir(path.dirname(t.dst));
    // 初始化一个sharp对象，用于图像处理  
    // 尝试读取源图像文件  
    const s = sharp(t.src);
    // 对图像进行重新调整尺寸，设置宽度为 t.width，保持原始宽高比  
    // 同时应用质量为 t.quality（默认值为85）的JPEG压缩，并使用"4:4:4"的色度子采样  
    const r = await s
      .resize({ width: t.width })
      .withMetadata()
      .jpeg({ quality: t.quality || 85, chromaSubsampling: "4:4:4" })
      // 将处理后的图像保存到目标文件  
      .toFile(t.dst);
    // 获取目标文件的文件信息  
    const fst = await fs.stat(t.dst);
    // 显示创建的缩略图的相关信息（包括路径、尺寸和文件大小）  
    log.showGreen("makeThumb", helper.pathShort(t.dst), `${r.width}x${r.height}`, `${helper.fileSizeSI(fst.size)}`, t.index, t.total);
    // 如果目标文件大小小于200KB，则可能文件损坏，删除该文件  
    // file may be corrupted, del it  
    if (fst.size < 200 * 1024) {
      await fs.remove(t.dst);
      log.showRed("makeThumb", `file too small, del ${t.dst}`);
    } else if (t.deleteOriginal) {
      try {
        await helper.safeRemove(t.src);
        log.showGray("makeThumb del:", helper.pathShort(t.src));
      } catch (error) {
        log.error("makeThumb", "del error", error);
      }
    }
    return r; // 返回处理后的图像信息对象  
  } catch (error) {
    // 如果在处理过程中出现错误，则捕获并处理错误信息  
    log.error("makeThumb", `error on '${t.src}'`, error);
    try { // 尝试删除已创建的目标文件，防止错误文件占用空间  
      await fs.remove(t.dst);
    } catch (error) { } // 忽略删除操作的错误，不进行额外处理  
  }
} // 结束函数定义

async function cmdThumbs(argv) {
  log.show('cmdThumbs', argv);
  const root = path.resolve(argv.input);
  assert.strictEqual("string", typeof root, "root must be string");
  if (!root || !(await fs.pathExists(root))) {
    ya.showHelp();
    log.error("cmdThumbs", `Invalid Input: '${root}'`);
    return;
  }
  const maxWidth = argv.max || 3000;
  const force = argv.force || false;
  const output = argv.output;
  // return;
  // const output = argv.output || root;
  log.show(`cmdThumbs: input:`, root);
  log.show(`cmdThumbs: output:`, output);

  const RE_THUMB = /(小图|精选|feature|web|thumb)/i;
  const walkOpts = {
    entryFilter: (f) =>
      f.stats.isFile() &&
      f.stats.size > 500 * 1024 &&
      helper.isImageFile(f.path) &&
      !RE_THUMB.test(f.path),
  };
  const files = await mf.walk(root, walkOpts);
  log.info("cmdThumbs", `total ${files.length} found`);

  let tasks = await Promise.all(
    files.map(
      throat(cpuCount, (f) =>
        prepareThumbArgs(f, {
          maxWidth: maxWidth,
          force: force,
          output: output,
        })
      )
    )
  );
  log.debug("cmdThumbs before filter: ", tasks.length);
  const total = tasks.length;
  tasks = tasks.filter((t) => t && t.dst);
  const skipped = total - tasks.length;
  log.debug("cmdThumbs after filter: ", tasks.length);
  if (skipped > 0) {
    log.showYellow(`cmdThumbs: ${skipped} thumbs skipped`)
  }
  if (tasks.length == 0) {
    log.showYellow("Nothing to do, abort.");
    return;
  }
  log.show(`cmdThumbs: task sample:`, tasks.slice(-1))
  const answer = await inquirer.prompt([
    {
      type: "confirm",
      name: "yes",
      default: false,
      message: chalk.bold.red(
        `Are you sure to make thumbs for ${tasks.length} files?`
      ),
    },
  ]);

  if (!answer.yes) {
    log.showYellow("Will do nothing, aborted by user.");
    return;
  }

  const startMs = Date.now();
  log.showGreen('cmdThumbs: startAt', dayjs().format())
  const result = await pMap(tasks, makeThumbOne, { concurrency: cpuCount });
  log.showGreen('cmdThumbs: endAt', dayjs().format())
  log.showGreen(`cmdThumbs: ${result.length} thumbs generated in ${helper.humanTime(startMs)}`)
}


// 文心一言注释 20231206
// 准备压缩图片的参数，并进行相应的处理  
async function prepareCompressArgs(f, options) {
  options = options || {};
  // log.show("prepareCompressArgs options:", options); // 打印日志，显示选项参数  
  const maxWidth = options.maxWidth || 4000; // 获取最大宽度限制，默认为4000  
  const force = options.force || false; // 获取强制压缩标志位，默认为false  
  const deleteOriginal = options.deleteOriginal || false; // 获取删除原文件标志位，默认为false  
  let fileSrc = path.resolve(f.path); // 解析源文件路径  
  const [dir, base, ext] = helper.pathSplit(fileSrc); // 将路径分解为目录、基本名和扩展名  
  let fileDst = path.join(dir, `${base}_Z4K.jpg`); // 构建目标文件路径，添加压缩后的文件名后缀  
  fileSrc = path.resolve(fileSrc); // 解析源文件路径（再次确认）  
  fileDst = path.resolve(fileDst); // 解析目标文件路径（再次确认）  

  if (await fs.pathExists(fileDst)) { // 如果目标文件已存在，则进行相应的处理  
    log.info("prepareCompress exists:", fileDst, force ? "(Override)" : ""); // 打印日志，显示目标文件存在的情况，以及是否进行覆盖处理  
    if (deleteOriginal) { // 如果设置了删除原文件标志位  
      await helper.safeRemove(fileSrc); // 删除源文件，并打印日志  
      log.showYellow('prepareCompress exists, delete', helper.pathShort(fileSrc)); // 打印日志，显示删除源文件信息，并以黄色字体显示警告信息  
    }
    if (!force) { // 如果未设置强制标志位，则直接返回（不再进行后续处理）  
      return;
    }
  }
  try { // 尝试执行后续操作，可能会抛出异常  
    const s = sharp(fileSrc); // 使用sharp库对源文件进行处理，返回sharp对象实例  
    const m = await s.metadata(); // 获取源文件的元数据信息（包括宽度和高度）  
    const nw = // 计算新的宽度，如果原始宽度大于高度，则使用最大宽度限制；否则按比例计算新的宽度  
      m.width > m.height ? maxWidth : Math.round((maxWidth * m.width) / m.height);
    const nh = Math.round((nw * m.height) / m.width); // 计算新的高度，按比例计算新的高度  

    const dw = nw > m.width ? m.width : nw; // 计算最终输出的宽度，如果新的宽度大于原始宽度，则使用原始宽度；否则使用新的宽度  
    const dh = nh > m.height ? m.height : nh; // 计算最终输出的高度，按比例计算最终输出高度，如果新的高度大于原始高度，则使用原始高度；否则使用新的高度  
    log.show(// 打印日志，显示压缩后的文件信息  
      "prepareCompress:",
      helper.pathShort(fileDst),
      `(${m.width}x${m.height} => ${dw}x${dh})`
    );
    return { // 返回压缩后的参数对象，包括输出文件的宽度、高度、源文件路径、目标文件路径以及索引信息等属性  
      width: dw,
      height: dh,
      src: fileSrc,
      dst: fileDst,
      index: f.index,
    };
  } catch (error) {
    log.error("prepareCompress error:", error, fileSrc);
  }
}

async function cmdCompress(argv) {
  const root = path.resolve(argv.input);
  assert.strictEqual("string", typeof root, "root must be string");
  if (!root || !(await fs.pathExists(root))) {
    ya.showHelp();
    log.error("cmdCompress", `Invalid Input: '${root}'`);
    return;
  }
  log.show('cmdCompress', argv);
  const force = argv.force || false;
  const quality = argv.quality || 88;
  const minFileSize = (argv.size || 2048) * 1024;
  const maxWidth = argv.width || 6000;
  const deleteOriginal = argv.delete || false;
  log.show(`cmdCompress: input:`, root);

  const RE_THUMB = /(Z4K|feature|web|thumb)/i;
  const walkOpts = {
    entryFilter: (f) =>
      f.stats.isFile()
      && f.stats.size > minFileSize
      && helper.isImageFile(f.path)
      && !RE_THUMB.test(f.path)
  };
  let files = await mf.walk(root, walkOpts);
  log.show("cmdCompress", `total ${files.length} files found (all)`);
  files = files.filter(f => !RE_THUMB.test(f.path));
  log.show("cmdCompress", `total ${files.length} files found (filtered)`);
  const confirmFiles = await inquirer.prompt([
    {
      type: "confirm",
      name: "yes",
      default: false,
      message: chalk.bold.green(`Press y to continue processing...`),
    },
  ]);
  if (!confirmFiles.yes) {
    log.showYellow("Will do nothing, aborted by user.");
    return;
  }
  let tasks = await Promise.all(
    files.map(
      throat(cpuCount, (f) =>
        prepareCompressArgs(f, {
          maxWidth: maxWidth,
          force: force,
          deleteOriginal: deleteOriginal
        })
      )
    )
  );
  log.debug("cmdCompress before filter: ", tasks.length);
  const total = tasks.length;
  tasks = tasks.filter((t) => t && t.dst);
  const skipped = total - tasks.length;
  log.debug("cmdCompress after filter: ", tasks.length);
  if (skipped > 0) {
    log.showYellow(`cmdCompress: ${skipped} thumbs skipped`)
  }
  if (tasks.length == 0) {
    log.showYellow("Nothing to do, abort.");
    return;
  }
  tasks.forEach(t => {
    t.total = tasks.length;
    t.quality = quality || 88;
    t.deleteOriginal = deleteOriginal || false;
  });
  log.show(`cmdCompress: task sample:`, tasks.slice(-2))
  const answer = await inquirer.prompt([
    {
      type: "confirm",
      name: "yes",
      default: false,
      message: chalk.bold.red(
        `Are you sure to compress ${tasks.length} files? \n[Apply to files bigger than ${minFileSize / 1024}K, and max long side is ${maxWidth}] \n${deleteOriginal ? "(Attention: you choose to delete original file!)" : "(Will keep original file)"}`
      ),
    },
  ]);

  if (!answer.yes) {
    log.showYellow("Will do nothing, aborted by user.");
    return;
  }

  const startMs = Date.now();
  log.showGreen('cmdCompress: startAt', dayjs().format())
  const result = await pMap(tasks, makeThumbOne, { concurrency: cpuCount / 2 + 1 });
  log.showGreen('cmdCompress: endAt', dayjs().format())
  log.showGreen(`cmdCompress: ${result.length} thumbs generated in ${helper.humanTime(startMs)}`)
}

function buildRemoveArgs(index, desc, shouldRemove, src) {
  return {
    index: index,
    desc: desc,
    shouldRemove: shouldRemove,
    src: src,
  };
}

async function prepareRemoveArgs(f, options) {
  const fileSrc = path.resolve(f.path);
  const fileName = path.basename(fileSrc);
  const [dir, base, ext] = helper.pathSplit(fileSrc);

  let conditions = options || {};
  //log.show("prepareRM options:", options);
  // 文件名列表规则
  const cNames = conditions.names || new Set();
  // 是否反转文件名列表
  const cReverse = conditions.reverse;
  const hasList = cNames && cNames.size > 0;

  let itemDesc = "";
  //----------------------------------------------------------------------
  if (hasList) {
    let shouldRemove = false;
    const nameInList = cNames.has(base.trim());
    if (cReverse) {
      shouldRemove = !nameInList;
    } else {
      shouldRemove = nameInList;
    }
    itemDesc = `IN=${nameInList} R=${cReverse}`;
    log.show(
      "prepareRM[List] add:",
      `${helper.pathShort(fileSrc)} ${itemDesc}`, f.index
    );
    return buildRemoveArgs(f.index, itemDesc, shouldRemove, fileSrc);
  }
  // 文件名列表是单独规则，优先级最高，如果存在，直接返回，忽略其它条件
  //----------------------------------------------------------------------

  // three args group
  // name pattern top1
  // width && height top2
  // size top3
  // 宽松模式，采用 OR 匹配条件，默认是 AND
  const cLoose = conditions.loose || false;
  // 最大宽度
  const cWidth = conditions.width || 0;
  // 最大高度
  const cHeight = conditions.height || 0;
  // 最大文件大小，单位k
  const cSize = conditions.size || 0;
  // 文件名匹配文本
  const cPattern = (conditions.pattern || "").toLowerCase();

  const hasName = cPattern && cPattern.length > 0;//1
  const hasSize = cSize > 0;//2
  const hasMeasure = cWidth > 0 || cHeight > 0;//3

  //log.show("prepareRM", `${cWidth}x${cHeight} ${cSize} /${cPattern}/`);

  let testName = false;
  let testSize = false;
  let testMeasure = false;

  try {
    // 首先检查名字正则匹配
    if (hasName) {
      const fName = fileName.toLowerCase();
      const rp = new RegExp(cPattern, "gi");
      itemDesc += ` PT=${cPattern}`;
      // 开头匹配，或末尾匹配，或正则匹配
      if (fName.startsWith(cPattern) || fName.endsWith(cPattern) || rp.test(fName)) {
        log.info(
          "prepareRM[Name]:", `${fileName} [NamePattern=${rp}]`
        );
        testName = true;
      } else {
        log.debug(
          "prepareRM[Name]:", `${fileName} [NamePattern=${rp}]`
        );
      }
    }

    // 其次检查文件大小是否满足条件
    if (hasSize) {
      const fst = await fs.stat(fileSrc);
      const fSize = fst.size || 0;
      itemDesc += ` ${Math.round(fSize / 1024)}k`
      if (fSize > 0 && fSize <= cSize) {
        log.info(
          "prepareRM[Size]:",
          `${fileName} [${Math.round(fSize / 1024)}k] [Size=${cSize / 1024}k]`
        );
        testSize = true;
      }
    }

    // 图片文件才检查宽高
    const isImage = helper.isImageFile(fileSrc);

    // 再次检查宽高是否满足条件
    if (hasMeasure) {
      if (isImage) {
        const s = sharp(fileSrc);
        const m = await s.metadata();
        const fWidth = m.width || 0;
        const fHeight = m.height || 0;
        itemDesc += ` ${fWidth}x${fHeight}`
        if (cWidth > 0 && cHeight > 0) {
          // 宽高都提供时，要求都满足才能删除
          if (fWidth <= cWidth && fHeight <= cHeight) {
            log.info(
              "prepareRM[Measure]:",
              `${fileName} ${fWidth}x${fHeight} [${cWidth}x${cHeight}]`
            );
            testMeasure = true;
          }
        }
        else {
          if (cWidth > 0 && fWidth <= cWidth) {
            // 只提供宽要求
            log.info(
              "prepareRM[Measure]:",
              `${fileName} ${fWidth}x${fHeight} [W=${cWidth}]`
            );
            testMeasure = true;
          } else if (cHeight > 0 && fHeight <= cHeight) {
            // 只提供高要求
            log.info(
              "prepareRM[Measure]:",
              `${fileName} ${fWidth}x${fHeight} [H=${cHeight}]`
            );
            testMeasure = true;
          }
        }
      } else {
        log.info("prepareRM[Measure]:", `${fileName} is not image file`);
      }
    }

    // 满足名字规则/文件大小/宽高任一规则即会被删除，或关系
    let shouldRemove = false;
    if (cLoose) {
      shouldRemove = testName || testSize || testMeasure;
    }
    else {
      // 必须同时满足所有用户已提供的条件，与关系
      shouldRemove = ((hasName && testName) || !hasName)
        && ((hasSize && testSize) || !hasSize)
        && ((isImage && hasMeasure && testMeasure) || !hasMeasure);
    }

    if (shouldRemove) {
      log.show(
        "prepareRM add:",
        `${helper.pathShort(fileSrc)} ${itemDesc}`, f.index
      );
    } else {
      (testName || testSize || testMeasure) && log.info(
        "prepareRM ignore:",
        `${helper.pathShort(fileSrc)} ${itemDesc} (${testName} ${testSize} ${testMeasure})`, f.index
      );
    }

    return {
      // conditions: conditions,
      // testName: testName,
      // testSize: testSize,
      // testMeasure: testMeasure,
      index: f.index,
      desc: itemDesc,
      shouldRemove: shouldRemove,
      src: fileSrc,
    };

  } catch (error) {
    log.error("prepareRM error:", error, fileSrc);
    // await fs.remove(fileSrc);
    fileLog(`<Error> ${fileSrc} (${f.index})`, "cmdRemove");
  }
}

async function readNameList(list) {
  const listContent = await fs.readFile(list, 'utf-8') || "";
  const nameList = listContent.split(/\r?\n/).map(x => path.parse(x).name.trim()).filter(Boolean);
  return new Set(nameList);
}

async function cmdRemove(argv) {
  assert.strictEqual("string", typeof argv.input, "root must be string");
  if (!argv.input || !(await fs.pathExists(argv.input))) {
    ya.showHelp();
    log.error("cmdRemove", `Invalid Input: '${argv.input}'`);
    return;
  }
  const root = path.resolve(argv.input);
  log.show('cmdRemove', argv);
  // 如果没有提供任何一个参数，报错，显示帮助
  if (argv.width == 0 && argv.height == 0 && argv.size == 0
    && !argv.pattern && !argv.list) {
    ya.showHelp();
    log.error("cmdRemove", `no arguments: width/height/size/pattern/list not supplied`);
    return;
  }

  const useSafeRemove = argv.safe || true;
  const cLoose = argv.loose || false;
  const cWidth = argv.width || 0;
  const cHeight = argv.height || 0;
  const cSize = argv.size * 1024 || 0;
  const cPattern = argv.pattern || "";
  const cReverse = argv.reverse || false;
  const cList = argv.list || "-not-exists";

  if (argv.dimension && argv.dimension.length > 0) {
    // 解析文件长宽字符串，例如 2160x4680
  }

  let cNames = [];
  if (await fs.pathExists(path.resolve(cList))) {
    try {
      const list = path.resolve(cList);
      const listStat = await fs.stat(list);
      if (listStat.isFile()) {
        cNames = (await readNameList(list)) || new Set();
      } else if (listStat.isDirectory()) {
        const dirFiles = (await fs.readdir(list)) || [];
        cNames = new Set(dirFiles.map(x => path.parse(x).name.trim()));
      } else {
        log.error("cmdRemove", `invalid arguments: list file invalid 1`);
        return;
      }
    } catch (error) {
      log.error(error);
      log.error("cmdRemove", `invalid arguments: list file invalid 2`);
      return;
    }
  }

  cNames = cNames || new Set();

  log.show("cmdRemove", `input:`, root);
  fileLog(`<Input> ${root}`, "cmdRemove");

  const conditions = {
    loose: cLoose,
    width: cWidth,
    height: cHeight,
    size: cSize,
    pattern: cPattern,
    names: cNames || new Set(),
    reverse: cReverse,
    safe: useSafeRemove,
  }

  const walkOpts = {
    entryFilter: (f) =>
      f.stats.isFile(),
    withIndex: true,
  };
  const files = await mf.walk(root, walkOpts);
  log.show("cmdRemove", `total ${files.length} files found`);

  let tasks = await Promise.all(
    files.map(
      throat(2 * cpuCount, (f) =>
        prepareRemoveArgs(f, conditions)
      )
    )
  );
  conditions.names = Array.from(cNames).slice(-5);
  const total = tasks.length;
  tasks = tasks.filter((t) => t && t.shouldRemove);
  const skipped = total - tasks.length;
  log.showYellow("cmdRemove", `${tasks.length} files to be removed`);
  if (skipped > 0) {
    log.showYellow("cmdRemove", `${skipped} files are ignored`)
  }
  if (tasks.length == 0) {
    log.show("cmdRemove", conditions);
    log.showGreen("Nothing to do, abort.");
    return;
  }

  log.show("cmdRemove", `task sample:`, tasks.slice(-1));
  log.showYellow("cmdRemove", conditions);
  if (cNames && cNames.size > 0) {
    // 默认仅删除列表中的文件，反转则仅保留列表中的文件，其它的全部删除，谨慎操作
    log.showYellow("cmdRemove", `Attention: use file name list, ignore all other conditions`);
    log.showRed("cmdRemove", `Attention: Will DELETE all files ${cReverse ? "NOT IN" : "IN"} the name list!`);
  }
  fileLog(`<Conditions> list=${cNames.size},loose=${cLoose},width=${cWidth},height=${cHeight},size=${cSize / 1024}k,name=${cPattern}`, "cmdRemove");
  const answer = await inquirer.prompt([
    {
      type: "confirm",
      name: "yes",
      default: false,
      message: chalk.bold.red(
        `Are you sure to remove ${tasks.length} files (total ${files.length}) using above conditions?`
      ),
    },
  ]);

  if (!answer.yes) {
    log.showYellow("Will do nothing, aborted by user.");
    return;
  }

  const startMs = Date.now();
  log.showGreen("cmdRemove", 'task startAt', dayjs().format())
  // const result = await pMap(tasks, fs.remove, { concurrency: cpuCount / 2 + 1 });
  let removedCount = 0;
  let index = 0;
  for (const task of tasks) {
    try {
      await useSafeRemove ? helper.safeRemove(task.src) : fs.remove(task.src);
      ++removedCount;
      fileLog(`<Removed> ${task.src} (${task.index})`, "cmdRemove");
      log.show("cmdRemove", `${useSafeRemove ? "Moved" : "Deleted"} ${task.src} (${task.index}) (${++index}/${tasks.length})`);
    } catch (error) {
      log.error("cmdRemove", `failed to remove file ${task.src}`, error);
    }
  }

  log.showGreen("cmdRemove", 'task endAt', dayjs().format())
  log.showGreen("cmdRemove", `${removedCount} files removed in ${helper.humanTime(startMs)}`)
  log.show("cmdRemove", `task logs are written to ${log.fileLogName()}`);
}