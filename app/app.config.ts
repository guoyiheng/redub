export default defineAppConfig({
  ui: {
    colors: { primary: 'terracotta', neutral: 'stone' },
    button: {
      variants: {
        size: {
          xs: { base: 'min-h-7 text-xs', leadingIcon: 'size-4', trailingIcon: 'size-4' },
          sm: { base: 'min-h-8 text-[13px]', leadingIcon: 'size-4', trailingIcon: 'size-4' },
          md: { base: 'min-h-8 text-sm', leadingIcon: 'size-4', trailingIcon: 'size-4' }
        }
      }
    },
    input: {
      variants: {
        size: {
          xs: { base: 'min-h-7 text-xs' },
          sm: { base: 'min-h-8 text-[13px]' },
          md: { base: 'min-h-8 text-sm' }
        }
      }
    },
    select: {
      variants: {
        size: {
          xs: { base: 'min-h-7 text-xs' },
          sm: { base: 'min-h-8 text-[13px]' },
          md: { base: 'min-h-8 text-sm' }
        }
      }
    },
    icons: {
      loading: 'i-carbon-renew',
      close: 'i-carbon-close',
      check: 'i-carbon-checkmark',
      chevronDown: 'i-carbon-chevron-down',
      chevronUp: 'i-carbon-chevron-up',
      chevronLeft: 'i-carbon-chevron-left',
      chevronRight: 'i-carbon-chevron-right',
      arrowLeft: 'i-carbon-arrow-left',
      arrowRight: 'i-carbon-arrow-right',
      external: 'i-carbon-launch',
      search: 'i-carbon-search',
      plus: 'i-carbon-add',
      minus: 'i-carbon-subtract',
      ellipsis: 'i-carbon-overflow-menu-horizontal'
    }
  }
})
