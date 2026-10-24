window.__ModuleLoader__.load({
  id: 'dsh-crash-backup',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-crash-backup'

    const zh = {
      nav: '存档',
      title: '存档',
      desc: '把当前 DSH 环境压缩成单个存档，崩溃后可用独立脚本完整回档。功能正在实现中。',
    }

    const en = {
      nav: 'Saves',
      title: 'Saves',
      desc: 'Compress the current DSH environment into one save that an independent script can restore after a crash. Under construction.',
    }

    const DICTS = { zh, en }

    const CSS = `
.dcb-wrap { display:flex; flex-direction:column; gap:8px; color:var(--dsw-alias-label-primary); font-size:13px; }
.dcb-title { margin:0; font-size:16px; font-weight:600; line-height:1.4; }
.dcb-desc { margin:0; max-width:560px; color:var(--dsw-alias-label-secondary); line-height:1.6; }
`

    function SaveSection(props) {
      const t = props.t
      return h(
        'section',
        { className: 'dcb-wrap' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('h2', { className: 'dcb-title' }, t('title')),
        h('p', { className: 'dcb-desc' }, t('desc')),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-crash-backup: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-crash-backup',
            order: 45,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t }),
          },
          (ownerProps) => h(SaveSection, { ...ownerProps, t }),
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
