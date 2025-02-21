#!/usr/bin/env node
const program = require('commander');
const ora = require('ora');
const chalk = require('chalk');
const opn = require('opn');
const yesno = require('yesno');
const prompts = require('prompts');
const fs = require('fs');
const os = require('os');
const https = require('https');

const {version} = require('./package');

program
.version(version)
.option('-g, --generate', 'generate a static license summary file')
.option('-t, --type <type>', 'specify the type of the output file (html, json, csv)')
.option('-b, --browser', 'open up a browser and show generated static license summary file')
.option('--no-browser', 'prevents the browser from popping open')
.option('-i, --info', 'provides information about all direct dependency licenses')
.option('-o, --outputFilePath <path>', 'specify path and name of the output file')
.option('-nd, --no-dev', 'do not include devDependencies')
.option('-r, --recursive', 'recursively search for licenses in subdirectories')
.option('-d, --max-depth <depth>', 'set the maximum depth for recursive search')
.option('-v, --verbose', 'activate verbose logging ')
.parse(process.argv);

if (program.outputFilePath && !program.generate) {
  console.warn(chalk.bgYellow.black('Warning: Using --outputFilePath without -g (--generate) will not have any effect.'));
}

if (program.browser && !program.generate) {
  console.warn(chalk.bgYellow.black('Warning: Using --browser without -g (--generate) will not have any effect.'));
}

const LICENSE_FILENAMES = ['LICENSE', 'LICENSE.md', 'license', 'license.md', 'LICENSE.txt'];

(async function () {
  try {
    const packageFileExists = fs.existsSync('./package.json');
    const composerFileExists = fs.existsSync('./composer.json');
    const nodeModulesExists = fs.existsSync('./node_modules');
    const vendorFolderExists = fs.existsSync('./vendor');

    const recursive = program.recursive || false;
    const maxDepth = program.maxDepth || (recursive ? 0 : 1);
    const verbose = program.verbose || false;

    if (!packageFileExists && !composerFileExists) {
      console.error(chalk.red('There is no dependency file (package,json or composer.json) in the current directory.'));

      return;
    }

    if (!nodeModulesExists && !vendorFolderExists) {
      console.error(chalk.red('There is no dependency folder (node_modules/ or vendor/) in the current directory.'));

      return;
    }

    let sourceFile;
    if (packageFileExists && composerFileExists) {
      const promptResponse = await prompts({
        type: 'select',
        name: 'sourceFile',
        message: chalk.magentaBright('Which source file should get parsed?'),
        initial: 0,
        choices: [
          {title: chalk.blueBright('all'), value: 'all'},
          {title: chalk.blueBright('package.json'), value: 'package.json'},
          {title: chalk.blueBright('composer.json'), value: 'composer.json'}
        ],
      });

      sourceFile = promptResponse['sourceFile'];
    } else {
      sourceFile = packageFileExists ? 'package.json' : 'composer.json';
    }

    const isPackageMode = (type = sourceFile) => ['package.json', 'js'].includes(type);
    const isComposerMode = (type = sourceFile) => ['composer.json', 'php'].includes(type);
    const typeFile = (type = sourceFile) => isPackageMode(type) ? 'package.json' : 'composer.json';
    const typeFolder = (type = sourceFile) => isPackageMode(type) ? 'node_modules' : 'vendor';
    const folder = typeFolder(sourceFile);

    let packageDependencies = [];
    let composerDependencies = [];
    let dependencies = [];

    let sourceFiles = 'all' === sourceFile ? ['package.json', 'composer.json'] : [sourceFile];

    if (program.recursive) {
      // Walk through sourceFiles and search for same file name recursively in all depth levels
      // and add them to sourceFiles
      const walk = (dir, depth = 0) => {
        const files = fs.readdirSync(dir);
        for (let file of files) {
          const filePath = dir + '/' + file;
          if (fs.statSync(filePath).isDirectory()
            && (maxDepth === 0 || depth < maxDepth)
            && !['node_modules', 'vendor'].includes(file)
          ) {
            walk(filePath, depth + 1);
            continue;
          }
          if (sourceFiles.includes(file)
            && dir !== '.'
          ) {
            sourceFiles.push(filePath);
          }
        }
      };

      walk('.');

      // Remove duplicates
      sourceFiles = [...new Set(sourceFiles)];

      console.log(chalk.magentaBright('Found %d files to scan recursively'), sourceFiles.length);
    }

    if (verbose) console.log(chalk.magentaBright('Reading dependencies from %s...'), sourceFiles.join(', '));

    for (let sourceFilePath of sourceFiles) {
      const sourceFile = sourceFilePath.split('/').reverse()[0];
      const sourcePath = sourceFilePath.split('/').slice(0, -1).join('/');
      if (!fs.existsSync('./' + sourceFile)) {
        console.log(chalk.red('File "%s" does not exist.'), sourceFile);
        return;
      }

      let type = sourceFile === 'package.json' ? 'js' : 'php';
      if (verbose) {
        console.log(chalk.magentaBright('Reading dependencies from %s...'), sourceFile);
      }

      let typeDependencies = [];

      const content = fs.readFileSync('./' + sourceFilePath, 'utf-8');
      // Try to parse content as JSON and get dependencies and development dependencies
      try {
        const parsedContent = JSON.parse(content);
        typeDependencies = Object.keys(parsedContent[isPackageMode(sourceFile) ? 'dependencies' : 'require'] || {});
        if (!program.noDev) {
          typeDependencies = typeDependencies
            .concat(Object.keys(parsedContent[isPackageMode(sourceFile) ? 'devDependencies' : 'require-dev'] || {}));
        }
      } catch (e) {
        console.error(chalk.red('Error parsing file "%s"'), sourceFile, e);

        return;
      }
      if (isComposerMode(sourceFile)) {
        typeDependencies = typeDependencies.filter(d => d.indexOf('/') >= 0);
      }

      if (isPackageMode(sourceFile)) {
        packageDependencies = typeDependencies;
      } else {
        composerDependencies = typeDependencies;
      }

      // Add all type dependencies to the dependencies array, each as an object with the type
      dependencies = dependencies.concat(typeDependencies.map(d => {
        return {
          name: d,
          path: sourcePath,
          type
        };
      }));

      // Remove duplicates
      dependencies = dependencies.filter((d, i) => dependencies.findIndex(_d => _d.name === d.name) === i);

      // Sort dependencies by name
      dependencies = dependencies.sort((a, b) => a.name.localeCompare(b.name));
    }

    console.log(chalk.magentaBright(
      program.noDev ? 'Found %d dependencies' : 'Found %d dependencies and dev dependencies',
    ), dependencies.length);

    const spinner = ora({
      text: chalk.magentaBright('Scanning'),
      color: 'magenta'
    });
    if (!verbose) spinner.start();

    const sanitizeLicenseLabel = (label) => {
      if (!label) return null;

      if (typeof label === 'array') {
        return label.map(l => sanitizeLicenseLabel(l)).join(', ');
      }

      return `${label}`.replace('-', ' ');
    };

    const licenseItems = [];
    const licenseDownloads = {};
    const failures = [];
    let licenseFileCounter = 0;
    let licenseDownloadCounter = 0;
    for ({name: dependency, path, type} of dependencies) {
      if (!dependency) continue;
      const _folder = typeFolder(type);
      // console.log({dependency, path, type, _folder});
      try {
        const dependencyRoot = path ? `${path}` : '.';
        let dependencyFolder = fs.existsSync(`${dependencyRoot}/${_folder}/${dependency}`) ?
          `${dependencyRoot}/${_folder}/${dependency}` :
          `${dependencyRoot}/${dependency.split('/').reverse()[0]}`;
        if (!fs.existsSync(dependencyFolder)) {
          if (verbose) console.warn(chalk.red('Did not find directory for "%s"'), {
            dependency,
            path,
            type,
            _folder,
            dependencyFolder
          }.toString());
          failures.push(dependency);
        }
        const dependencyFolderFiles = fs.readdirSync(dependencyFolder);
        const descriptionFile = JSON.parse(fs.readFileSync(`./${dependencyFolder}/${typeFile(type)}`, 'utf-8'));

        const url = descriptionFile.repository?.url || descriptionFile.repository;

        const licenseItem = {
          module: dependency,
          type: sanitizeLicenseLabel(descriptionFile.license),
          description: descriptionFile.description || null,
          packageType: type,
          url: descriptionFile.repository ? descriptionFile.repository.url : null
        };

        // Check for license file
        const licenseFile = LICENSE_FILENAMES.filter(f => dependencyFolderFiles.includes(f));
        if (licenseFile.length > 0) {
          licenseFileCounter++;
          licenseItem['license'] = fs.readFileSync(`./${dependencyFolder}/${licenseFile[0]}`, 'utf-8');

          licenseItems.push(licenseItem);
          continue;
        }

        // Check for repository
        if ((isPackageMode(type) && descriptionFile.hasOwnProperty('repository')) || isComposerMode(type)) {
          const fetchLicenseFileFromRepo = async (url) => {
            let message = 'Trying to fetch license file from "' + url + '"... ';
            const response = await request(url);
            message += response.code >= 400 ? 'failed (' + response.code + ')' : 'succeeded';
            if (verbose) console.log(chalk.blueBright(message));

            return response;
          };

          let rawUrl;
          if (isPackageMode(type)) {
            const url = new URL(url);
            const repoUrl = url.href.replace(/^git\+/, '')
            .replace(/\.git$/, '')
            .replace('ssh://git@', 'https://');

            rawUrl = repoUrl
            .replace('https://github.com', 'https://raw.githubusercontent.com');
          } else {
            rawUrl = 'https://raw.githubusercontent.com/' + dependency;
          }

          for (let branch of ['main', 'master', 'dev', 'develop']) {
            for (let licenseFilename of LICENSE_FILENAMES) {
              const fullRequestUrl = `${rawUrl}/${branch}/${licenseFilename}`;

              if (Object.keys(licenseDownloads).indexOf(fullRequestUrl) > -1) {
                licenseDownloadCounter++;
                licenseItem['license'] = licenseDownloads[fullRequestUrl];

                licenseItems.push(licenseItem);
                break;
              } else {
                const response = await fetchLicenseFileFromRepo(fullRequestUrl);

                if (response.code === 200) {
                  licenseDownloadCounter++;
                  licenseItem['license'] = response.data;
                  licenseDownloads[fullRequestUrl] = response.data;

                  licenseItems.push(licenseItem);
                  break;
                }
              }
            }

            if (licenseItem.hasOwnProperty('license')) break;
          }

          if (licenseItem.hasOwnProperty('license')) continue;
        }

        failures.push(dependency);
        if (verbose) console.warn(chalk.red('No file or download available for "%s"'), dependency);
        licenseItems.push(licenseItem);
      } catch (e) {
        if (verbose) console.warn(chalk.red('Did not find directory for "%s"'), dependency, e);
      }
    }
    if (!verbose) spinner.succeed(chalk.magentaBright('Scanning done!'));

    console.log(chalk.magentaBright('The following licenses are used:'),
      [...new Set(licenseItems.map(i => i.type))].filter(i => i).join(', ')
    );
    console.log(chalk.magentaBright('Found %d license files'), licenseFileCounter);
    console.log(chalk.magentaBright('Downloaded %d license files'), licenseDownloadCounter);
    if (failures.length > 0) {
      console.log(chalk.red('No license file found (%d):'), failures.length);
      for (let fail of failures) {
        console.log(chalk.redBright(' - ' + fail));
      }
    }

    if (program.info) {
      const licenseInfo = licenseItems.map(i => {
        return {
          module: i.module,
          license: sanitizeLicenseLabel(i.type)
        };
      }).reduce((result, current) => {
        if (!current.license) return result;

        if (!result.hasOwnProperty(current.license)) {
          result[current.license] = [current.module];
        } else {
          result[current.license].push(current.module);
        }

        return result;
      }, {});
      for (let licenseType of Object.keys(licenseInfo)) {
        console.log(chalk.blueBright.bold(`${licenseType} (%d usages)`), licenseInfo[licenseType].length);
        for (let module of licenseInfo[licenseType]) {
          console.log(chalk.blueBright(`  |-- ${module}`));
        }
      }
    }

    if (program.generate) {
      const fileType = program.type || 'html';
      if (['html', 'json', 'csv'].includes(fileType)) {
        const filePath = program.outputFilePath || (os.tmpdir() + '/license.' + fileType);

        console.log(chalk.cyanBright('Creating license summary file to "%s"...'), filePath);
        let output = '';
        for (let f of licenseItems) {
          let licenseText = f['license'] || 'No license file provided.';

          if (fileType === 'html') {
            output += `
        <details open>
          <summary>${f['module']} - ${f['type'] || 'No license provided'} - ${f['packageType']}</summary>
          <p>${f['type'] ? `<strong>${f['type']}</strong> - ` : ''}${f['description']}</p>
          <pre>${licenseText}</pre>
          <p>${f['url'] ? `Repository: <a href="${f['url']}" target="_blank">${f['url']}</a>` : ''}</p>
        </details>
      `;
          } else if (fileType === 'json') {
            const entry = {
              module: f['module'],
              description: f['description'],
              license: f['type'] || 'No license provided',
              packageType: f['packageType'],
              url: f['url']
            };
            output += JSON.stringify(entry, null, 2) + ',\n';
          } else if (fileType === 'csv') {
            // Use CSV format, with ',' as separator and '"' as enclosure
            const entry = [
              f['module'],
              f['type'],
              f['url'],
            ];
            output += entry.map(e => e ? `"${e}"` : null).join(',') + '\n';
          }
        }

        if (fileType === 'json') {
          output = '[' + output.slice(0, -2) + ']';
        } else if (fileType === 'csv') {
          output = '"module","type","url"\n' + output;
        }

        fs.writeFileSync(filePath, output, 'utf-8');

        if (program.browser !== false) {
          let showInBrowser = program.browser;
          if (!showInBrowser) {
            showInBrowser = await yesno({
              question: chalk.cyanBright('Show output file in browser? (Y/n)'),
              defaultValue: 'y'
            });
          }

          if (showInBrowser) opn(filePath);
        }
      }
    }
  } catch (e) {
    console.error(chalk.red(e));
  }
})();

/**
 * Async http GET method
 * @param url
 * @returns {Promise<any>}
 */
function request(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });

      response.on('end', () => {
        resolve({
          code: response.statusCode,
          data
        });
      });
    }).on('error', (err) => {
      console.warn(chalk.red('Error requesting url "%s"'), url, err);

      reject(err);
    });
  })
}
