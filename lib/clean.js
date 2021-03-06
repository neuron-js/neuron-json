'use strict'

var cleaner = exports

var util      = require('util')
var async     = require('async')
var fs        = require('fs')
var node_path = require('path')
var expand    = require('fs-expand')
var typo      = require('typo')
var make_array = require('make-array')
var unique     = require('array-unique')


var REGEX_PACKAGE_NAME = /^[a-z][a-z0-9.-]*$/
var REGEX_PACKAGE_NAME_SHOULD_NOT_ENDS = /[.-]$/

cleaner.check_name = function (name) {
  return REGEX_PACKAGE_NAME.test(name)
    && !REGEX_PACKAGE_NAME_SHOULD_NOT_ENDS.test(name)
}


cleaner.clean = function (cwd, pkg, callback) {
  pkg.name = pkg.name || node_path.basename(cwd)
  pkg.version = pkg.version || '*'

  if (!cleaner.check_name(pkg.name)) {
    return callback({
      code: 'NEURON_INVALID_NAME',
      message: [
        'Invalid package name "' + pkg.name + '". A package name should:',
        '  - {{bold only}} contain lowercased letters, numbers, dots(.) and dashes(-)',
        '  - start with a letter',
        '  - end with a letter or number'
      ]
      .map(function (template) {
        return typo.template(template)
      })
      .join('\n')
    })
  }

  async.each([
    // 'check_dirs',
    'clean_pkg_css',
    'clean_pkg_main',
    'clean_pkg_entries',
    'clean_pkg_dist'
    // 'clean_pkg_as'
  ], function (task, done) {
    cleaner[task](cwd, pkg, done)

  }, function (err) {
    if (err) {
      return callback(err)
    }
    cleaner.check_entry(cwd, pkg, callback)
  })
}


// Cortex must be something to export
cleaner.check_entry = function (cwd, pkg, callback) {
  if (!pkg.main && !pkg.css.length && !pkg.entries.length && !pkg.dist.length) {
    return callback({
      code: 'NEURON_NO_ENTRY',
      message: [
        'A package must do something. At least {{bold ONE}} of the 4 fields should be defined and existing in "' + cwd + '"',
        '   - `{{bold neuron.main}}`   : it could be `require()`d',
        '   - `{{bold neuron.css}}`    : the css file(s) could be depent by other packages',
        '   - `{{bold neuron.entries}}`: could be accessed with `facade()`.',
        '   - `{{bold neuron.dist}}`   : the already-bundled dist file.'
      ]
      .map(function (template) {
        return typo.template(template)
      })
      .join('\n')
    }, pkg)
  }

  // All values of the fields are already converted to posix style
  var name_js = './' + pkg.name + '.js'
  if (~pkg.entries.indexOf(name_js)) {
    return callback({
      code: 'NEURON_MAIN_CONFLICT',
      message: 'An entry file should not be named as "<name>.js", or you could rename it.',
      data: {
        entry: name_js
      }
    })
  }
  callback(null, pkg)
}


// Checks `neuron.directories`
cleaner.check_dirs = function (cwd, pkg, callback) {
  var directories = pkg.directories || {}

  if ('css' in directories) {
    return callback({
      code: 'NO_SUPPORT_DIR_CSS',
      message: 'Cortex will no longer support `neuron.directories.css` since 4.0.0,\n'
        + '   use `neuron.css` instead.'
    })
  }

  callback(null, pkg)
}


// Check the existence of neuron.main
// if not exists, pkg.main will be deleted.
cleaner.clean_pkg_main = function (cwd, pkg, callback) {
  var main = pkg.main
  var parsed
  if (main) {
    parsed = cleaner._test_file(cwd, main)
    if (!parsed) {
      return callback({
        code: 'NEURON_MAIN_NOT_FOUND',
        message: '`neuron.main` is defined as "' + main + '", but not found in "' + cwd + '"',
        data: {
          main: main
        }
      })
    }
    return cb(parsed)
  }

  var index = 'index.js'
  var name_js = cleaner._test_file(cwd, pkg.name + '.js')
  // fallback to 'index.js' -> '<name>.js'
  parsed = cleaner._test_file(cwd, index) || name_js
  cb(parsed)

  function cb (parsed) {
    // `pkg` might has a prototype, so we can't remove a key by deleting them.
    // set it to undefined, `JSON.stringify()` will ignore it.
    pkg.main = parsed
    callback(null, pkg)
  }
}


cleaner.clean_pkg_dist = function (cwd, pkg, callback) {
  cleaner._clean_pkg_field(cwd, pkg, 'dist', callback)
}


cleaner._test_file = function (cwd, file) {
  var origin = file
  var file = node_path.join(cwd, file)
  try {
    file = require.resolve(file)
  } catch(e) {
    return false
  }

  // `require.resolve` is really weird that it will change the path of temp directory.
  // The situation below might happen:
  // ```
  // var a = '/var/folders/xxxxxx'
  // var b = require.resolve(a) // -> /private/var/folders/xxxxx.js
  // ```
  var index = file.indexOf(cwd)
  if (~index) {
    // b -> '/var/folders/xxxxx.js'
    file = file.slice(index)
  }

  // Check if file is a `.node` file
  file = cleaner._ban_ext_node(file, origin)
  if (!file) {
    return false
  }

  // './index.js' -> '/path/to/index.js' -> 'index.js'
  file = node_path.relative(cwd, file)
  return cleaner._standardize(file)
}


cleaner._ban_ext_node = function (parsed, origin) {
  // If the resolved file is a '.node' file
  // - it is originally a '.node' file  -> you take your own responsibility
  // - it is resolved to a '.node' file -> actually it is not allowed in browser -> not found
  return node_path.extname(parsed) === '.node' && node_path.extname(origin) !== '.node'
    ? null
    : parsed
}


cleaner.clean_pkg_entries = function (cwd, pkg, callback) {
  pkg.entries = make_array(pkg.entries)

  // adds test cases by default
  if (!process.env.NEURON_NO_TEST_ENTRY) {
    pkg.entries.push('test/*.js')
  }

  cleaner._clean_pkg_field(cwd, pkg, 'entries', callback)
}


cleaner.clean_pkg_css = function (cwd, pkg, callback) {
  cleaner._clean_pkg_field(cwd, pkg, 'css', callback)
}


// `pkg.as` might be `require.async()`d
// in which situation that it will not be checked by commonjs-walker.
// So, we check it ahead of time.
cleaner.clean_pkg_as = function (cwd, pkg, callback) {
  var as_ = pkg['as']
  if (!as_) {
    return callback(null)
  }

  async.each(Object.keys(as_), function (origin, done) {
    if (cleaner._is_relative(origin)) {
      delete as_[origin]
      return done(null)
    }

    var path = as_[origin]
    if (!cleaner._is_relative(path)) {
      return done(null)
    }

    var found = cleaner._test_file(cwd, path)
    if (!found) {
      return done({
        code: 'AS_NOT_FOUND',
        message: '"' + path + '" of `neuron.as` is not found',
        data: {
          path: path
        }
      })
    }

    if (found.indexOf('..') === 0) {
      return done({
        code: 'AS_OUT_OF_RANGE',
        message: '"' + path + '" of `neuron.as` is out of current package',
        data: {
          path: path
        }
      })
    }

    as_[origin] = found
    done(null)
  }, callback)
}


cleaner._standardize = function (path) {
  // In windows, the resolved path will divided with `\\`,
  // But neuron.json should not contain all of these.
  path = cleaner._normalize_windows_path(path)

  // Do not care about absolute paths which are not allowed here.
  return path.indexOf('../') === 0 || path.indexOf('./') === 0
    ? path
    : './' + path
}


cleaner._is_relative = function (path) {
  // We deal with the module id in `pkg.as` not file path,
  // and it will not affect windows,
  // so we should not use `node_path.sep` for windows.
  return path.indexOf('../') === 0 || path.indexOf('./') === 0
}


var isWindows = process.platform === 'win32'
cleaner._normalize_windows_path = function (path) {
  return isWindows
    ? path.replace(/\\/g, '/')
    : path
}


// @param {string} key
cleaner._clean_pkg_field = function (cwd, pkg, key, callback) {
  var KEY = key.toUpperCase()
  cleaner._expand_items(cwd, pkg[key], function (err, files) {
    if (err) {
      if (err.code === 'NOT_FOUND') {
        return callback({
          code: 'NEURON_' + KEY + '_NOT_FOUND',
          message: 'The files defined in `neuron.' + key + '`, but not found:\n'
            + err.data.not_found.map(function (file) {
              return '   - ' + file
            }).join('\n'),
          data: err.data
        })
      }
      return callback(err)
    }
    pkg[key] = unique(files)
    callback(null)
  })
}


cleaner._expand_items = function (cwd, value, callback) {
  if (!value) {
    // #8
    // standardize `pkg.css` and make sure it is always an array.
    return callback(null, [])
  }

  value = make_array(value)

  var glob_patterns = []
  var explicit_paths = []
  value.forEach(function (v) {
    if (~v.indexOf('*')) {
      glob_patterns.push(v)
    } else {
      explicit_paths.push(v)
    }
  })

  var tasks = []
  var found = []
  var globbed = []
  if (glob_patterns.length) {
    tasks.push(function (done) {
      expand(glob_patterns, {
        cwd: cwd
      }, function (err, files) {
        if (err) {
          return done(err)
        }
        globbed = files
        done(null)
      })
    })
  }

  if (explicit_paths.length) {
    tasks.push(function (done) {
      cleaner._check_multi_exists(cwd, explicit_paths, function (not_found) {
        if (not_found.length) {
          return done({
            code: 'NOT_FOUND',
            data: {
              not_found: not_found
            }
          })
        }
        found = explicit_paths.map(function (path) {
          // './pages/a.js' -> 'pages/a.js'
          return node_path.join('.', path)
        })
        done(null)
      })
    })
  }

  async.parallel(tasks, function (err) {
    // `globbed.length` is larger usually
    callback(err, globbed.concat(found).map(cleaner._standardize))
  })
}


// @param {function(not_found)}
cleaner._check_multi_exists = function (cwd, paths, callback) {
  var not_found = []
  async.each(paths, function (path, done) {
    var absolute = node_path.join(cwd, path)
    // We only check the existance of the file,
    // because we only gives "enough" hints for people who makes a mistake,
    // but never cares about the situation user deliberately break something.
    fs.exists(absolute, function (exists) {
      if (!exists) {
        not_found.push(path)
      }
      // there will be no errors.
      done(null)
    })
  }, function () {
    callback(not_found)
  })
}
