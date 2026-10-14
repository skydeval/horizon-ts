import {useKawaiiMode} from '#/state/preferences/kawaii'

export type LogoVariant = 'default' | 'kawaii'

export function useLogoVariant(allowVariants = true): LogoVariant {
  const kawaii = useKawaiiMode()

  if (!allowVariants) return 'default'
  // HORIZON: the kawaii artwork is not covered by MIT and was removed
  if (kawaii) return 'default'
  return 'default'
}
