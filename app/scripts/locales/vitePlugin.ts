import type { Plugin } from 'vite'

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import { checkContentLock } from './contentLock'
import { checkProject, cleanCatalog, createPseudoCatalog, readCatalog, readRegistry } from './core'
import { INCLUSION_POLICY_PATH } from './inclusionPolicy'

export const LOCALE_MODULE = 'virtual:block-pet-locales'
const resolvedLocaleModule = '\0block-pet-locales'
const previewModule = '\0block-pet-locale-preview'

export function createLocaleModule(root: string, development: boolean): string {
  const registry = readRegistry(root)
  const metadata = Object.entries(registry.locales).filter(([, locale]) => development || locale.status === 'ready')
  const catalogs = Object.fromEntries(metadata.map(([code, locale]) => [code, locale.status === 'draft' ? cleanCatalog(readCatalog(root, code)) : readCatalog(root, code)]))
  const previewLocales = development
    ? metadata.filter(([, locale]) => locale.status === 'draft').map(([value, locale]) => ({ value, label: locale.nativeName, direction: locale.direction }))
    : []
  if (development) {
    const english = readCatalog(root, registry.fallbackLocale)
    catalogs['en-XA'] = createPseudoCatalog(english)
    catalogs['ar-XB'] = createPseudoCatalog(english, 'rtl')
    previewLocales.push({ value: 'en-XA', label: 'Long pseudo language', direction: 'ltr' }, { value: 'ar-XB', label: 'RTL pseudo language', direction: 'rtl' })
  }
  const antNames = [...new Set(metadata.map(([, locale]) => locale.antdLocale))]
  const imports = antNames.map((name, index) => `import ant${index} from 'ant-design-vue/locale/${name}';`).join('\n')
  const antEntries = metadata.map(([code, locale]) => `${JSON.stringify(code)}:ant${antNames.indexOf(locale.antdLocale)}`)
  if (development) {
    const fallbackIndex = antNames.indexOf(registry.locales[registry.fallbackLocale].antdLocale)
    antEntries.push(`'en-XA':ant${fallbackIndex}`, `'ar-XB':ant${fallbackIndex}`)
  }
  return `${imports}\nexport const messages=${JSON.stringify(catalogs)};\nexport const antdLocales={${antEntries.join(',')}};\nexport const previewLocales=${JSON.stringify(previewLocales)};\n`
}

export function localePlugin(root: string): Plugin {
  const projectRoot = realpathSync.native(root)
  let development = false
  const registryPath = resolve(projectRoot, 'src/locales/registry.json').replaceAll('\\', '/')
  return {
    name: 'block-pet-reviewed-locales',
    enforce: 'pre',
    configResolved(config) {
      development = config.command === 'serve'
    },
    buildStart() {
      const registry = readRegistry(projectRoot)
      this.addWatchFile(registryPath)
      this.addWatchFile(resolve(projectRoot, 'src/locales/reviews.json'))
      this.addWatchFile(resolve(projectRoot, INCLUSION_POLICY_PATH))
      for (const code of Object.keys(registry.locales)) this.addWatchFile(resolve(projectRoot, `src/locales/${code}.json`))
      if (!development) {
        const report = checkProject(projectRoot, { release: true })
        if (!report.ok) throw new Error(`Locale release check failed:\n${report.errors.join('\n')}`)
        checkContentLock(projectRoot)
      }
    },
    resolveId(id) {
      if (id === LOCALE_MODULE) return resolvedLocaleModule
      if (development && id === '/__locale_preview.ts') return previewModule
    },
    load(id) {
      if (id === resolvedLocaleModule) return createLocaleModule(projectRoot, development)
      if (development && id === previewModule) return previewSource
      const candidate = id.replaceAll('\\', '/').split('?')[0]
      if (!development && candidate.endsWith('/src/locales/registry.json')) {
        const canonical = realpathSync.native(candidate).replaceAll('\\', '/')
        if (canonical === registryPath) {
          const registry = readRegistry(projectRoot)
          return JSON.stringify({ ...registry, locales: Object.fromEntries(Object.entries(registry.locales).filter(([, locale]) => locale.status === 'ready')) })
        }
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/__locale_preview') {
          next()
          return
        }
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Block Pet locale preview</title></head><body><div id="locale-preview"></div><script type="module" src="/@vite/client"></script><script type="module" src="/__locale_preview.ts"></script></body></html>')
      })
    },
    handleHotUpdate(context) {
      if (context.file.replaceAll('\\', '/').startsWith(`${resolve(projectRoot, 'src/locales').replaceAll('\\', '/')}/`)) {
        const module = context.server.moduleGraph.getModuleById(resolvedLocaleModule)
        if (module) context.server.moduleGraph.invalidateModule(module)
        context.server.ws.send({ type: 'full-reload' })
        return []
      }
    },
  }
}

const previewSource = `
import {createApp,computed,h,ref,watch} from 'vue';
import {createI18n} from 'vue-i18n';
import {Button,ConfigProvider,Input,Select,Slider,Switch,Modal} from 'ant-design-vue';
import ProList from '/src/components/pro-list/index.vue';
import ProListItem from '/src/components/pro-list-item/index.vue';
import {appDarkAlgorithm,appLightAlgorithm} from '/src/config/theme';
import registry from '/src/locales/registry.json';
import {messages,antdLocales,previewLocales} from 'virtual:block-pet-locales';
import 'ant-design-vue/dist/reset.css';
import '/src/assets/css/global.scss';
import 'virtual:uno.css';
const flatten=(value,prefix='')=>Object.entries(value).flatMap(([key,text])=>typeof text==='string'?[[prefix+key,text]]:flatten(text,prefix+key+'.'));
const options=[...Object.entries(registry.locales).map(([value,metadata])=>({value,label:metadata.nativeName,direction:metadata.direction})),...previewLocales.filter(item=>!registry.locales[item.value])];
const requested=new URLSearchParams(location.search).get('locale')||'en-XA';
const selected=ref(options.some(item=>item.value===requested)?requested:registry.fallbackLocale),dark=ref(false),slider=ref(30),open=ref(false),filter=ref('');
const i18n=createI18n({legacy:false,locale:selected.value,fallbackLocale:registry.fallbackLocale,messages,missingWarn:false,fallbackWarn:false});
const direction=computed(()=>options.find(item=>item.value===selected.value)?.direction||'ltr');
watch(selected,value=>{i18n.global.locale.value=value;document.documentElement.lang=value;document.documentElement.dir=direction.value},{immediate:true});
const rows=computed(()=>flatten(messages[selected.value]).filter(([key,value])=>!filter.value||key.includes(filter.value)||value.includes(filter.value)));
const t=key=>i18n.global.t(key);
const App={setup(){return()=>h(ConfigProvider,{direction:direction.value,locale:antdLocales[selected.value],theme:{algorithm:dark.value?appDarkAlgorithm:appLightAlgorithm}},()=>h('main',{id:'locale-preview-shell',class:'preference-sections',dir:direction.value,style:{margin:'auto',padding:'20px',maxWidth:'911px',minHeight:'100vh',background:dark.value?'#161616':'#fafafa',color:dark.value?'#eee':'#171717'}},[
h('h1',{style:{fontSize:'22px'}},'Block Pet — locale preview'),
h('p',null,'Development-only preview. No native commands, settings or user data are accessed.'),
h('div',{style:{display:'flex',gap:'12px',flexWrap:'wrap',alignItems:'center',marginBlock:'16px'}},[
h(Select,{id:'locale-preview-language',value:selected.value,options:options.map(({value,label})=>({value,label})),style:{minWidth:'200px'},'onUpdate:value':value=>selected.value=value}),
h('label',null,[h(Switch,{id:'locale-preview-dark',checked:dark.value,'onUpdate:checked':value=>dark.value=value}),' Dark']),
h(Button,{id:'locale-preview-dialog',onClick:()=>open.value=true},()=>t('pages.preference.general.labels.language'))]),
h(ProList,{title:t('pages.preference.general.labels.language')},()=>[
h(ProListItem,{title:t('pages.preference.general.labels.language'),description:t('pages.preference.general.options.systemLanguage')},()=>h(Select,{value:'system',options:[{value:'system',label:t('pages.preference.general.options.systemLanguage')},{value:'long',label:rows.value.find(([key,value])=>value.length>100)?.[1]||'Long option'}],dropdownMatchSelectWidth:false,style:{maxWidth:'100%'}})),
h(ProListItem,{title:t('pages.preference.general.labels.language')},()=>h(Slider,{id:'locale-preview-slider',value:slider.value,'onUpdate:value':value=>slider.value=value,style:{width:'180px',maxWidth:'100%'}})),
h(ProListItem,{title:'URL / numeric input'},()=>h(Input,{value:'https://example.invalid/ 123.45',dir:'ltr',style:{maxWidth:'260px'}}))]),
h(Modal,{open:open.value,title:t('pages.preference.general.labels.language'),onCancel:()=>open.value=false,onOk:()=>open.value=false},()=>h('p',null,rows.value.find(([key,value])=>value.length>100)?.[1])),
h(Input,{id:'locale-preview-filter',value:filter.value,'onUpdate:value':value=>filter.value=value,placeholder:'Filter catalog keys',style:{marginBlock:'20px'}}),
h('div',{id:'locale-preview-catalog',style:{overflowWrap:'anywhere'}},rows.value.map(([key,value])=>h('section',{key,style:{borderBlockStart:'1px solid #8885',paddingBlock:'8px'}},[h('code',{dir:'ltr',style:{fontSize:'11px',display:'block'}},key),h('div',{style:{whiteSpace:'pre-wrap'}},value)])))
]))}};
createApp(App).use(i18n).mount('#locale-preview');
`
