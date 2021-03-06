const fs = require('fs-extra')
const path = require('path')
const chalk = require('chalk')
const prettier = require('prettier')
const traverse = require('babel-traverse').default
const t = require('babel-types')
const template = require('babel-template')
const generate = require('babel-generator').default
const taroize = require('@tarojs/taroize')
const wxTransformer = require('@tarojs/transformer-wx')

const {
  BUILD_TYPES,
  MINI_APP_FILES,
  printLog,
  pocessTypeEnum,
  promoteRelativePath,
  resolveScriptPath,
  REG_SCRIPT,
  REG_TYPESCRIPT,
  processStyleImports,
  getPkgVersion,
  pascalCase
} = require('./util')

const Creator = require('./creator')

const prettierJSConfig = {
  semi: false,
  singleQuote: true,
  parser: 'babylon'
}

function analyzeImportUrl (sourceFilePath, scriptFiles, source, value) {
  const valueExtname = path.extname(value)
  if (path.isAbsolute(value)) {
    printLog(pocessTypeEnum.ERROR, '引用文件', `文件 ${sourceFilePath} 中引用 ${value} 是绝对路径！`)
    return
  }
  if (value.indexOf('.') === 0) {
    if (REG_SCRIPT.test(valueExtname) || REG_TYPESCRIPT.test(valueExtname)) {
      const vpath = path.resolve(sourceFilePath, '..', value)
      let fPath = value
      if (fs.existsSync(vpath)) {
        fPath = vpath
      } else {
        printLog(pocessTypeEnum.ERROR, '引用文件', `文件 ${sourceFilePath} 中引用 ${value} 不存在！`)
      }
      scriptFiles.add(fPath)
    } else {
      let vpath = resolveScriptPath(path.resolve(sourceFilePath, '..', value))
      if (vpath) {
        if (!fs.existsSync(vpath)) {
          printLog(pocessTypeEnum.ERROR, '引用文件', `文件 ${sourceFilePath} 中引用 ${value} 不存在！`)
        } else {
          if (fs.lstatSync(vpath).isDirectory()) {
            if (fs.existsSync(path.join(vpath, 'index.js'))) {
              vpath = path.join(vpath, 'index.js')
            } else {
              printLog(Util.pocessTypeEnum.ERROR, '引用目录', `文件 ${sourceFilePath} 中引用了目录 ${value}！`)
              return
            }
          }
          let relativePath = path.relative(sourceFilePath, vpath)
          const relativePathExtname = path.extname(relativePath)
          scriptFiles.add(vpath)
          relativePath = promoteRelativePath(relativePath)
          if (/\.wxs/.test(relativePathExtname)) {
            relativePath += '.js'
          } else {
            relativePath = relativePath.replace(relativePathExtname, '.js')
          }
          source.value = relativePath
        }
      }
    }
  }
}

class Convertor {
  constructor () {
    this.root = process.cwd()
    this.convertRoot = path.join(this.root, 'taroConvert')
    this.convertDir = path.join(this.convertRoot, 'src')
    this.importsDir = path.join(this.convertDir, 'imports')
    this.fileTypes = MINI_APP_FILES[BUILD_TYPES.WEAPP]
    this.pages = new Set()
    this.components = new Set()
    this.hadBeenCopyedFiles = new Set()
    this.hadBeenBuiltComponents = new Set()
    this.hadBeenBuiltImports = new Set()
    this.init()
  }

  init () {
    console.log(chalk.green('开始代码转换...'))
    this.initConvert()
    this.getApp()
    this.getPages()
    this.getSubPackages()
  }

  initConvert () {
    if (fs.existsSync(this.convertRoot)) {
      fs.emptyDirSync(this.convertRoot)
    } else {
      fs.mkdirpSync(this.convertRoot)
    }
  }

  parseAst ({ ast, sourceFilePath, outputFilePath, importStylePath, depComponents, imports = [] }) {
    const scriptFiles = new Set()
    const self = this
    traverse(ast, {
      Program: {
        enter (astPath) {
          astPath.traverse({
            ImportDeclaration (astPath) {
              const node = astPath.node
              const source = node.source
              const value = source.value
              analyzeImportUrl(sourceFilePath, scriptFiles, source, value)
            },
            CallExpression (astPath) {
              const node = astPath.node
              const callee = node.callee
              if (callee.name === 'require') {
                const args = node.arguments
                const value = args[0].value
                analyzeImportUrl(sourceFilePath, scriptFiles, args[0], value)
              }
            }
          })
        },
        exit (astPath) {
          const lastImport = astPath.get('body').filter(p => p.isImportDeclaration()).pop()
          if (lastImport) {
            if (importStylePath) {
              lastImport.insertAfter(t.importDeclaration([], t.stringLiteral(promoteRelativePath(path.relative(sourceFilePath, importStylePath)))))
            }
            if (imports && imports.length) {
              imports.forEach(({ name, ast }) => {
                const importName = pascalCase(name)
                const importPath = path.join(self.importsDir, importName + '.js')
                if (!self.hadBeenBuiltImports.has(importPath)) {
                  self.hadBeenBuiltImports.add(importPath)
                  self.writeFileToTaro(importPath, prettier.format(generate(ast).code, prettierJSConfig))
                }
                lastImport.insertAfter(template(`import ${importName} from '${promoteRelativePath(path.relative(outputFilePath, importPath))}'`, {
                  sourceType: 'module'
                })())
              })
            }
            if (depComponents && depComponents.size) {
              depComponents.forEach(componentObj => {
                const name = pascalCase(componentObj.name)
                const component = componentObj.path
                lastImport.insertAfter(template(`import ${name} from '${promoteRelativePath(path.relative(sourceFilePath, component))}'`, {
                  sourceType: 'module'
                })())
              })
            }
          }
        }
      }
    })

    return {
      ast,
      scriptFiles
    }
  }

  getApp () {
    this.entryJSPath = path.join(this.root, `app${this.fileTypes.SCRIPT}`)
    this.entryJSONPath = path.join(this.root, `app${this.fileTypes.CONFIG}`)
    this.entryStylePath = path.join(this.root, `app${this.fileTypes.STYLE}`)
    try {
      this.entryJSON = JSON.parse(String(fs.readFileSync(this.entryJSONPath)))
      printLog(pocessTypeEnum.CONVERT, '入口文件', this.generateShowPath(this.entryJSPath))
      printLog(pocessTypeEnum.CONVERT, '入口配置', this.generateShowPath(this.entryJSONPath))
      if (fs.existsSync(this.entryStylePath)) {
        this.entryStyle = String(fs.readFileSync(this.entryStylePath))
        printLog(pocessTypeEnum.CONVERT, '入口样式', this.generateShowPath(this.entryStylePath))
      }
    } catch (err) {
      this.entryJSON = {}
      console.log(chalk.red(`app${this.fileTypes.CONFIG} 读取失败，请检查！`))
      process.exit(1)
    }
  }

  getPages () {
    const pages = this.entryJSON['pages']
    if (!pages || !pages.length) {
      console.log(chalk.red(`app${this.fileTypes.CONFIG} 配置有误，缺少页面相关配置`))
      return
    }
    this.pages = new Set(pages)
  }

  getSubPackages () {
    const subPackages = this.entryJSON['subpackages'] || this.entryJSON['subPackages']
    if (!subPackages || !subPackages.length) {
      return
    }
    subPackages.forEach(item => {
      if (item.pages && item.pages.length) {
        const root = item.root
        item.pages.forEach(page => {
          let pagePath = `${root}/${page}`
          pagePath = pagePath.replace(/\/{2,}/g, '/')
          this.pages.add(pagePath)
        })
      }
    })
  }

  generateScriptFiles (files) {
    if (!files) {
      return
    }
    if (files.size) {
      files.forEach(file => {
        if (!fs.existsSync(file) || this.hadBeenCopyedFiles.has(file)) {
          return
        }
        const code = fs.readFileSync(file).toString()
        let outputFilePath = file.replace(this.root, this.convertDir)
        const extname = path.extname(outputFilePath)
        if (/\.wxs/.test(extname)) {
          outputFilePath += '.js'
        }
        const transformResult = wxTransformer({
          code,
          sourcePath: file,
          outputPath: outputFilePath,
          isNormal: true,
          isTyped: REG_TYPESCRIPT.test(file)
        })
        const { ast, scriptFiles } = this.parseAst({
          ast: transformResult.ast,
          outputFilePath,
          sourceFilePath: file
        })
        const jsCode = generate(ast).code
        this.writeFileToTaro(outputFilePath, prettier.format(jsCode, prettierJSConfig))
        printLog(pocessTypeEnum.COPY, 'JS 文件', this.generateShowPath(outputFilePath))
        this.hadBeenCopyedFiles.add(file)
        this.generateScriptFiles(scriptFiles)
      })
    }
  }

  writeFileToTaro (dist, code) {
    fs.ensureDirSync(path.dirname(dist))
    fs.writeFileSync(dist, code)
  }

  getDistFilePath (src, extname) {
    if (!extname) return src.replace(this.root, this.convertDir)
    return src.replace(this.root, this.convertDir).replace(path.extname(src), extname)
  }

  generateShowPath (filePath) {
    return filePath.replace(path.join(this.root, '/'), '').split(path.sep).join('/')
  }

  generateEntry () {
    try {
      const entryJS = String(fs.readFileSync(this.entryJSPath))
      const entryJSON = JSON.stringify(this.entryJSON)
      const entryDistJSPath = this.getDistFilePath(this.entryJSPath)
      const taroizeResult = taroize({
        json: entryJSON,
        script: entryJS,
        path: path.dirname(entryJS)
      })
      const { ast, scriptFiles } = this.parseAst({
        ast: taroizeResult.ast,
        sourceFilePath: this.entryJSPath,
        outputFilePath: entryDistJSPath,
        importStylePath: this.entryStyle ? this.entryStylePath.replace(path.extname(this.entryStylePath), '.css') : null
      })
      const jsCode = generate(ast).code
      this.writeFileToTaro(entryDistJSPath, prettier.format(jsCode, prettierJSConfig))
      printLog(pocessTypeEnum.GENERATE, '入口文件', this.generateShowPath(entryDistJSPath))
      if (this.entryStyle) {
        const entryDistStylePath = this.getDistFilePath(this.entryStylePath, '.css')
        this.writeFileToTaro(entryDistStylePath, this.entryStyle)
        printLog(pocessTypeEnum.GENERATE, '入口样式', this.generateShowPath(entryDistStylePath))
      }
      this.generateScriptFiles(scriptFiles)
    } catch (err) {
      console.log(err)
    }
  }

  traversePages () {
    this.pages.forEach(page => {
      const pagePath = path.join(this.root, page)
      const pageJSPath = pagePath + this.fileTypes.SCRIPT
      const pageDistJSPath = this.getDistFilePath(pageJSPath)
      const pageConfigPath = pagePath + this.fileTypes.CONFIG
      const pageStylePath = pagePath + this.fileTypes.STYLE
      const pageDistStylePath = this.getDistFilePath(pageStylePath, '.css')
      const pageTemplPath = pagePath + this.fileTypes.TEMPL

      try {
        const param = {}
        const depComponents = new Set()
        if (!fs.existsSync(pageJSPath)) {
          throw new Error(`页面 ${page} 没有 JS 文件！`)
        }
        printLog(pocessTypeEnum.CONVERT, '页面文件', this.generateShowPath(pageJSPath))

        if (fs.existsSync(pageConfigPath)) {
          printLog(pocessTypeEnum.CONVERT, '页面配置', this.generateShowPath(pageConfigPath))
          const pageConfigStr = String(fs.readFileSync(pageConfigPath))
          const pageConfig = JSON.parse(pageConfigStr)
          const pageUsingComponnets = pageConfig.usingComponents
          if (pageUsingComponnets) {
            // 页面依赖组件
            Object.keys(pageUsingComponnets).forEach(component => {
              let componentPath = path.resolve(pageConfigPath, '..', pageUsingComponnets[component])
              if (!fs.existsSync(resolveScriptPath(componentPath))) {
                componentPath = path.join(this.root, pageUsingComponnets[component])
              }
              depComponents.add({
                name: component,
                path: componentPath
              })
            })
            delete pageConfig.usingComponents
          }
          param.json = JSON.stringify(pageConfig)
        }
        param.script = String(fs.readFileSync(pageJSPath))
        if (fs.existsSync(pageTemplPath)) {
          printLog(pocessTypeEnum.CONVERT, '页面模板', this.generateShowPath(pageTemplPath))
          param.wxml = String(fs.readFileSync(pageTemplPath))
        }
        let pageStyle = null
        if (fs.existsSync(pageStylePath)) {
          printLog(pocessTypeEnum.CONVERT, '页面样式', this.generateShowPath(pageStylePath))
          pageStyle = String(fs.readFileSync(pageStylePath))
        }
        param.path = path.dirname(pageJSPath)
        const taroizeResult = taroize(param)
        const { ast, scriptFiles } = this.parseAst({
          ast: taroizeResult.ast,
          sourceFilePath: pageJSPath,
          outputFilePath: pageDistJSPath,
          importStylePath: pageStyle ? pageStylePath.replace(path.extname(pageStylePath), '.css') : null,
          depComponents,
          imports: taroizeResult.imports
        })
        const jsCode = generate(ast).code
        this.writeFileToTaro(pageDistJSPath, prettier.format(jsCode, prettierJSConfig))
        printLog(pocessTypeEnum.GENERATE, '页面文件', this.generateShowPath(pageDistJSPath))
        if (pageStyle) {
          this.writeFileToTaro(pageDistStylePath, pageStyle)
          printLog(pocessTypeEnum.GENERATE, '页面样式', this.generateShowPath(pageDistStylePath))
          this.traverseStyle(pageStylePath, pageStyle)
        }
        this.generateScriptFiles(scriptFiles)
        this.traverseComponents(depComponents)
      } catch (err) {
        printLog(pocessTypeEnum.ERROR, '页面转换', this.generateShowPath(pageJSPath))
        console.log(err)
      }
    })
  }

  traverseComponents (components) {
    if (!components || !components.size) {
      return
    }
    components.forEach(componentObj => {
      const component = componentObj.path
      if (this.hadBeenBuiltComponents.has(component)) return
      const componentJSPath = component + this.fileTypes.SCRIPT
      const componentDistJSPath = this.getDistFilePath(componentJSPath)
      const componentConfigPath = component + this.fileTypes.CONFIG
      const componentStylePath = component + this.fileTypes.STYLE
      const componentDistStylePath = this.getDistFilePath(componentStylePath, '.css')
      const componentTemplPath = component + this.fileTypes.TEMPL

      try {
        const param = {}
        const depComponents = new Set()
        if (!fs.existsSync(componentJSPath)) {
          throw new Error(`组件 ${component} 没有 JS 文件！`)
        }
        printLog(pocessTypeEnum.CONVERT, '组件文件', this.generateShowPath(componentJSPath))
        if (fs.existsSync(componentConfigPath)) {
          printLog(pocessTypeEnum.CONVERT, '组件配置', this.generateShowPath(componentConfigPath))
          const componentConfigStr = String(fs.readFileSync(componentConfigPath))
          const componentConfig = JSON.parse(componentConfigStr)
          const componentUsingComponnets = componentConfig.usingComponents
          if (componentUsingComponnets) {
            // 页面依赖组件
            Object.keys(componentUsingComponnets).forEach(component => {
              let componentPath = path.resolve(componentConfigPath, '..', componentUsingComponnets[component])
              if (!fs.existsSync(resolveScriptPath(componentPath))) {
                componentPath = path.join(this.root, componentUsingComponnets[component])
              }
              depComponents.add({
                name: component,
                path: componentPath
              })
            })
            delete componentConfig.usingComponents
          }
          param.json = JSON.stringify(componentConfig)
        }
        param.script = String(fs.readFileSync(componentJSPath))
        if (fs.existsSync(componentTemplPath)) {
          printLog(pocessTypeEnum.CONVERT, '组件模板', this.generateShowPath(componentTemplPath))
          param.wxml = String(fs.readFileSync(componentTemplPath))
        }
        let componentStyle = null
        if (fs.existsSync(componentStylePath)) {
          printLog(pocessTypeEnum.CONVERT, '组件样式', this.generateShowPath(componentStylePath))
          componentStyle = String(fs.readFileSync(componentStylePath))
        }
        param.path = path.dirname(componentJSPath)
        const taroizeResult = taroize(param)
        const { ast, scriptFiles } = this.parseAst({
          ast: taroizeResult.ast,
          sourceFilePath: componentJSPath,
          outputFilePath: componentDistJSPath,
          importStylePath: componentStyle ? componentStylePath.replace(path.extname(componentStylePath), '.css') : null,
          depComponents,
          imports: taroizeResult.imports
        })
        const jsCode = generate(ast).code
        this.writeFileToTaro(componentDistJSPath, prettier.format(jsCode, prettierJSConfig))
        printLog(pocessTypeEnum.GENERATE, '组件文件', this.generateShowPath(componentDistJSPath))
        if (componentStyle) {
          this.writeFileToTaro(componentDistStylePath, componentStyle)
          printLog(pocessTypeEnum.GENERATE, '组件样式', this.generateShowPath(componentDistStylePath))
          this.traverseStyle(componentStylePath, componentStyle)
        }
        this.generateScriptFiles(scriptFiles)
        this.traverseComponents(depComponents)
      } catch (err) {
        printLog(pocessTypeEnum.ERROR, '组件转换', this.generateShowPath(componentJSPath))
        console.log(err)
      }
    })
  }

  traverseStyle (filePath, style) {
    const { imports } = processStyleImports(style, BUILD_TYPES.WEAPP)
    if (imports && imports.length) {
      imports.forEach(importItem => {
        const importPath = path.resolve(path.dirname(filePath), importItem)
        if (fs.existsSync(importPath)) {
          const styleText = fs.readFileSync(importPath).toString()
          const styleDist = importPath.replace(this.root, this.convertDir)
          this.writeFileToTaro(styleDist, styleText)
          printLog(pocessTypeEnum.COPY, '样式文件', this.generateShowPath(styleDist))
          this.traverseStyle(filePath, styleText)
        }
      })
    }
  }

  generateConfigFiles () {
    const creator = new Creator()
    const templateName = 'default'
    const configDir = path.join(this.convertRoot, 'config')
    const pkgPath = path.join(this.convertRoot, 'package.json')
    const projectName = 'taroConvert'
    const description = ''
    const version = getPkgVersion()
    const dateObj = new Date()
    const date = `${dateObj.getFullYear()}-${(dateObj.getMonth() + 1)}-${dateObj.getDate()}`
    creator.template(templateName, 'pkg', pkgPath, {
      description,
      projectName,
      version,
      css: 'none',
      typescript: false
    })
    creator.template(templateName, path.join('config', 'index'), path.join(configDir, 'index.js'), {
      date,
      projectName
    })
    creator.template(templateName, path.join('config', 'dev'), path.join(configDir, 'dev.js'))
    creator.template(templateName, path.join('config', 'prod'), path.join(configDir, 'prod.js'))
    creator.template(templateName, 'project', path.join(this.convertRoot, 'project.config.json'), {
      description,
      projectName
    })
    creator.template(templateName, 'gitignore', path.join(this.convertRoot, '.gitignore'))
    creator.template(templateName, 'editorconfig', path.join(this.convertRoot, '.editorconfig'))
    creator.template(templateName, 'eslintrc', path.join(this.convertRoot, '.eslintrc'))
    creator.template(templateName, 'indexhtml', path.join(this.convertDir, 'index.html'))
    creator.fs.commit(() => {
      const pkgObj = JSON.parse(fs.readFileSync(pkgPath).toString())
      pkgObj.dependencies['@tarojs/with-weapp'] = `^${version}`
      fs.writeJSONSync(pkgPath, pkgObj, {
        spaces: 2,
        EOL: '\n'
      })
      printLog(pocessTypeEnum.GENERATE, '文件', this.generateShowPath(path.join(configDir, 'index.js')))
      printLog(pocessTypeEnum.GENERATE, '文件', this.generateShowPath(path.join(configDir, 'dev.js')))
      printLog(pocessTypeEnum.GENERATE, '文件', this.generateShowPath(path.join(configDir, 'prod.js')))
      printLog(pocessTypeEnum.GENERATE, '文件', this.generateShowPath(pkgPath))
      printLog(pocessTypeEnum.GENERATE, '文件', this.generateShowPath(path.join(this.convertRoot, 'project.config.json')))
      printLog(pocessTypeEnum.GENERATE, '文件', this.generateShowPath(path.join(this.convertRoot, '.gitignore')))
      printLog(pocessTypeEnum.GENERATE, '文件', this.generateShowPath(path.join(this.convertRoot, '.editorconfig')))
      printLog(pocessTypeEnum.GENERATE, '文件', this.generateShowPath(path.join(this.convertRoot, '.eslintrc')))
      printLog(pocessTypeEnum.GENERATE, '文件', this.generateShowPath(path.join(this.convertDir, 'index.html')))
    })
  }

  run () {
    this.generateEntry()
    this.traversePages()
    this.generateConfigFiles()
  }
}

module.exports = Convertor
