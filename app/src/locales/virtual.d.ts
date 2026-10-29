declare module 'virtual:block-pet-locales' {
  export interface MessageCatalog {
    [key: string]: string | MessageCatalog
  }
  export const messages: Record<string, MessageCatalog>
  export const antdLocales: Record<string, import('ant-design-vue/es/locale').Locale>
  export const previewLocales: Array<{ value: string, label: string, direction: 'ltr' | 'rtl' }>
}
