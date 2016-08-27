  var request = require('request');
  var path = require('path');
  var os = require('os');
  var fs = require('fs');
  var exec = require('child_process').exec;
  var spawn = require('child_process').spawn;
  var cpr = require('cpr');
  var del = require('del');
  var semver = require('semver');

  var platform = process.platform;
  platform = /^win/.test(platform)? 'win' : /^darwin/.test(platform)? 'mac' : 'linux' + (process.arch == 'ia32' ? '32' : '64');


  /**
   * Creates new instance of updater. Manifest could be a `package.json` of project.
   *
   * Note that compressed apps are assumed to be downloaded in the format produced by [node-webkit-builder](https://github.com/mllrsohn/node-webkit-builder) (or [grunt-node-webkit-builder](https://github.com/mllrsohn/grunt-node-webkit-builder)).
   *
   * @constructor
   * @param {object} manifest - See the [manifest schema](#manifest-schema) below.
   * @param {object} options - Optional
   * @property {string} options.temporaryDirectory - (Optional) path to a directory to download the updates to and unpack them in. Defaults to [`os.tmpdir()`](https://nodejs.org/api/os.html#os_os_tmpdir)
   * @property {string} options.toolsDirectory - (Optional) path to a directory with the tools to be used. Defaults to  __dirname + '/tools'
   */
  function updater(manifest, options){
    this.manifest = manifest;
    this.options = {
      temporaryDirectory: options && options.temporaryDirectory || os.tmpdir(),
      toolsDirectory: options && options.toolsDirectory || path.join(__dirname, 'tools'),
      macExecFiles: options && options.macExecFiles || []
    };
  }


  /**
   * Will check the latest available version of the application by requesting the manifest specified in `manifestUrl`.
   *
   * The callback will always be called; the second parameter indicates whether or not there's a newer version.
   * This function assumes you use [Semantic Versioning](http://semver.org) and enforces it; if your local version is `0.2.0` and the remote one is `0.1.23456` then the callback will be called with `false` as the second paramter. If on the off chance you don't use semantic versioning, you could manually download the remote manifest and call `download` if you're happy that the remote version is newer.
   *
   * @param {function} cb - Callback arguments: error, newerVersionExists (`Boolean`), remoteManifest
   */
  updater.prototype.checkNewVersion = function(cb){
    request.get(this.manifest.manifestUrl, gotManifest.bind(this)); //get manifest from url

    /**
     * @private
     */
    function gotManifest(err, req, data){
      if(err) {
        return cb(err);
      }

      if(req.statusCode < 200 || req.statusCode > 299){
        return cb(new Error(req.statusCode));
      }

      try{
        data = JSON.parse(data);
      } catch(e){
        return cb(e)
      }

      cb(null, semver.gt(data.version, this.manifest.version), data);
    }
  };

  /**
   * Downloads the new app to a template folder
   * @param  {Function} cb - called when download completes. Callback arguments: error, downloaded filepath
   * @param  {Object} newManifest - see [manifest schema](#manifest-schema) below
   * @return {Request} Request - stream, the stream contains `manifest` property with new manifest and 'content-length' property with the size of package.
   */
  updater.prototype.download = function(cb, newManifest){
    var manifest = newManifest || this.manifest;
    var url = manifest.packages[platform].url;
    var pkg = request(url, function(err, response){
        if(err){
            cb(err);
        }
        if(response && (response.statusCode < 200 || response.statusCode >= 300)){
            pkg.abort();
            return cb(new Error(response.statusCode));
        }
    });
    pkg.on('response', function(response){
      if(response && response.headers && response.headers['content-length']){
          pkg['content-length'] = response.headers['content-length'];
        }
    });
    var filename = path.basename(url),
        destinationPath = path.join(this.options.temporaryDirectory, filename);
    // download the package to template folder
    fs.unlink(path.join(this.options.temporaryDirectory, filename), function(){
      pkg.pipe(fs.createWriteStream(destinationPath));
      pkg.resume();
    });
    pkg.on('error', cb);
    pkg.on('end', appDownloaded);
    pkg.pause();

    function appDownloaded(){
      process.nextTick(function(){
        if(pkg.response.statusCode >= 200 && pkg.response.statusCode < 300){
          cb(null, destinationPath);
        }
      });
    }
    return pkg;
  };


  /**
   * Returns executed application path
   * @returns {string}
   */
  updater.prototype.getAppPath = function(){
    var appPath = {
      mac: path.join(process.cwd(),'../../..'),
      win: path.dirname(process.execPath)
    };
    appPath.linux32 = appPath.win;
    appPath.linux64 = appPath.win;
    return appPath[platform];
  };


  /**
   * Returns current application executable
   * @returns {string}
   */
  updater.prototype.getAppExec = function(){
    var execFolder = this.getAppPath();
    var exec = {
      mac: '',
      win: path.basename(process.execPath),
      linux32: path.basename(process.execPath),
      linux64: path.basename(process.execPath)
    };
    return path.join(execFolder, exec[platform]);
  };


  /**
   * Will unpack the `filename` in temporary folder.
   * For Windows, [unzip](https://www.mkssoftware.com/docs/man1/unzip.1.asp) is used (which is [not signed](https://github.com/edjafarov/node-webkit-updater/issues/68)).
   *
   * @param {string} filename
   * @param {function} cb - Callback arguments: error, unpacked directory
   * @param {object} manifest
   */
  updater.prototype.unpack = function(filename, cb, manifest){
    var args = [filename, cb, manifest, this.options.temporaryDirectory];
    return pUnpack[platform].apply(this, args);
  };

  /**
   * @private
   * @param {string} zipPath
   * @param {string} temporaryDirectory
   * @return {string}
   */
  var getZipDestinationDirectory = function(zipPath, temporaryDirectory){
      return path.join(temporaryDirectory, path.basename(zipPath, path.extname(zipPath)));
    },
    /**
     * @private
     * @param {object} manifest
     * @return {string}
     */
    getExecPathRelativeToPackage = function(manifest){
      var execPath = manifest.packages[platform] && manifest.packages[platform].execPath;

      if(execPath){
        return execPath;
      }
      else {
        var suffix = {
          win: '.exe',
          mac: '.app'
        };
        return manifest.name + (suffix[platform] || '');
      }
    };


  var pUnpack = {
    /**
     * @private
     */
    mac: function(filename, cb, manifest, temporaryDirectory){
      var args = arguments,
        extension = path.extname(filename),
        destination = path.join(temporaryDirectory, path.basename(filename, extension));

      if(!fs.existsSync(destination)){
        fs.mkdirSync(destination);
      }

      if(extension === ".zip"){
        exec('unzip -xo "' + filename + '" >/dev/null',{ cwd: destination }, function(err){
          if(err){
            console.info(err);
            return cb(err);
          }
          var appPath = path.join(destination, getExecPathRelativeToPackage(manifest));
          cb(null, appPath);
        })

      }
      else if(extension === ".dmg"){
        // just in case if something was wrong during previous mount
        exec('hdiutil unmount /Volumes/'+path.basename(filename, '.dmg'), function(err){
          // create a CDR from the DMG to bypass any steps which require user interaction
          var cdrPath = filename.replace(/.dmg$/, '.cdr');
          try {
            fs.unlinkSync(cdrPath);
          } catch (e) {
            console.info(e)
          }
          exec('hdiutil convert "' + filename + '" -format UDTO -o "' + cdrPath + '"', function(err){
            exec('hdiutil attach "' + cdrPath + '" -nobrowse', function(err){
              if(err) {
                if(err.code == 1){
                  pUnpack.mac.apply(this, args);
                }
                return cb(err);
              }
              findMountPoint(path.basename(filename, '.dmg'), cb);
            });
          });
        });

        function findMountPoint(dmg_name, callback) {
          exec('hdiutil info', function(err, stdout){
            if (err) return callback(err);
            var results = stdout.split("\n");
            var dmgExp = new RegExp(dmg_name + '$');
            for (var i=0,l=results.length;i<l;i++) {
              if (results[i].match(dmgExp)) {
                var mountPoint = results[i].split("\t").pop();
                var fileToRun = path.join(mountPoint, dmg_name + ".app");
                return callback(null, fileToRun);
              }
            }
            callback(Error("Mount point not found"));
          })
        }
      }
    },
    /**
     * @private
     */
    win: function(filename, cb, manifest, temporaryDirectory){
      var self = this;
      var destinationDirectory = getZipDestinationDirectory(filename, temporaryDirectory),
          unzip = function(){
            // unzip by C. Spieler (docs: https://www.mkssoftware.com/docs/man1/unzip.1.asp, issues: http://www.info-zip.org/)
            exec( '"' + path.resolve(self.options.toolsDirectory, 'unzip.exe') + '" -u -o "' +
                filename + '" -d "' + destinationDirectory + '" > NUL', function(err){
              if(err){
                return cb(err);
              }

              cb(null, path.join(destinationDirectory, getExecPathRelativeToPackage(manifest)));
            });
          };
      var suffix = 0;
      while (fs.existsSync(destinationDirectory + (suffix || ''))) {
        suffix++;
      }
      destinationDirectory = destinationDirectory + (suffix || '');
      unzip();
    },
    /**
     * @private
     */
    linux32: function(filename, cb, manifest, temporaryDirectory){
      //filename fix
      exec('tar -zxvf "' + filename + '" >/dev/null',{cwd: temporaryDirectory}, function(err){
        console.info(arguments);
        if(err){
          console.info(err);
          return cb(err);
        }
        cb(null,path.join(temporaryDirectory, getExecPathRelativeToPackage(manifest)));
      })
     }
  };
  pUnpack.linux64 = pUnpack.linux32;


  /**
   * Runs installer
   * @param {string} appPath
   * @param {array} args - Arguments which will be passed when running the new app
   * @param {object} options - Optional
   * @returns {function}
   */
  updater.prototype.runInstaller = function(appPath, args, options){
    return pRun[platform].apply(this, arguments);
  };

  var pRun = {
    /**
     * @private
     */
    mac: function(appPath, args, options, cb){
      // //spawn
      // if(args && args.length) {
      //   args = [appPath].concat('--args', args);
      // } else {
      //   args = [appPath];
      // }
      // return run('open', args, options);
      var relaunch_app = path.resolve(this.options.toolsDirectory, 'relaunch_app.sh');
      var args2 = [relaunch_app, '1', appPath].concat(args || []);
      return run('bash', args2, options, cb);
    },
    /**
     * @private
     */
    win: function(appPath, args, options, cb){
      var invis = path.resolve(this.options.toolsDirectory, 'invis.vbs');
      var relaunch_app = path.resolve(this.options.toolsDirectory, 'relaunch_app.bat');
      var args2 = [invis, relaunch_app, '1', appPath].concat(args || []);
      return run('wscript.exe', args2, options, cb);
    },
    /**
     * @private
     */
    linux32: function(appPath, args, options, cb){
      var appExec = path.join(appPath, path.basename(this.getAppExec()));
      fs.chmodSync(appExec, 0755)
      if(!options) options = {};
      options.cwd = appPath;
      return run(appPath + "/"+path.basename(this.getAppExec()), args, options, cb);
    }
  };

  pRun.linux64 = pRun.linux32;

  /**
   * @private
   */
  function run(path, args, options){
    var opts = {
      detached: true,
      stdio: 'ignore'
    };
    for(var key in options){
      opts[key] = options[key];
    }
    var sp = spawn(path, args, opts);
    sp.unref();
    return sp;
  }

  /**
   * Installs the app (copies current application to `copyPath`)
   * @param {string} copyPath
   * @param {function} cb - Callback arguments: error
   */
  updater.prototype.install = function(copyPath, cb){
    pInstall[platform].apply(this, arguments);
  };

  var pInstall = {
    /**
     * @private
     */
    mac: function(to, cb){
      var self = this;
      cpr(self.getAppPath(), to, {
        deleteFirst: true
      }, function(err){
        if(err){
          return cb(err);
        }
        console.info('Fixing permissions...');
        var basePath = to;
        console.info('basePath: ' + basePath);
        console.info(self.options.macExecFiles);
        self.options.macExecFiles.forEach(function (file) {
          var filePath = path.join(basePath, file);
          console.info(filePath);
          fs.chmodSync(filePath, '755');
        });
        return cb();
      });
    },
    /**
     * @private
     */
    win: function(to, cb){
      var self = this;
      cpr(self.getAppPath(), to, {
        deleteFirst: true
      }, function (err) {
        if(err){
          //TODO: do something if there is an error??
        }
        cb(err);
      });
    },
    /**
     * @private
     */
    linux32: function(to, cb){
      cpr(this.getAppPath(), to, {
        deleteFirst: true
      }, cb);
    }
  };
  pInstall.linux64 = pInstall.linux32;

  /**
   * Runs the app from original app executable path.
   * @param {string} execPath
   * @param {array} args - Arguments passed to the app being ran.
   * @param {object} options - Optional. See `spawn` from nodejs docs.
   *
   * Note: if this doesn't work, try `gui.Shell.openItem(execPath)` (see [node-webkit Shell](https://github.com/rogerwang/node-webkit/wiki/Shell)).
   */
  updater.prototype.run = function(execPath, args, options){
    var arg = arguments;
    if(platform.indexOf('linux') === 0) arg[0] = path.dirname(arg[0]);
    pRun[platform].apply(this, arg);
  };

  module.exports = updater;
