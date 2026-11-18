/**
 * Pontes entre a app e o site. Os caminhos respeitam o BASE_URL da build:
 * no GitHub Pages a app vive em /<repo>/app/ e o site na raiz /<repo>/.
 */
const base = import.meta.env.BASE_URL

export const links = {
  terms: `${base}legal/terms.html`,
  privacy: `${base}legal/privacy.html`,
  /** Página inicial (landing 3D): um nível acima da app. */
  home: base.endsWith('/app/') ? base.slice(0, -'app/'.length) : '/',
}
