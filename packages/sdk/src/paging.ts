/**
 * Paginação no estilo das Azure SDK Design Guidelines.
 *
 * ```ts
 * // item a item (o SDK pede as páginas quando precisa)
 * for await (const user of client.admin.users.list()) console.log(user.id)
 *
 * // página a página, ex.: para uma tabela
 * for await (const page of client.admin.users.list().byPage({ maxPageSize: 50 })) render(page)
 * ```
 */
export interface PageSettings {
  /** Continuar a partir de uma página anterior (devolvida em `continuationToken`). */
  continuationToken?: string | undefined
  /** Tamanho de página pedido. A API pode devolver menos. */
  maxPageSize?: number | undefined
}

export interface Page<T> {
  items: T[]
  /** Total de resultados no servidor, quando a API o sabe. */
  total?: number | undefined
  /** Passa isto em `byPage({ continuationToken })` para continuar; `undefined` na última página. */
  continuationToken?: string | undefined
}

export interface PagedAsyncIterableIterator<T> extends AsyncIterableIterator<T> {
  byPage(settings?: PageSettings): AsyncIterableIterator<Page<T>>
}

export function pagedIterator<T>(
  fetchPage: (token: string | undefined, maxPageSize: number | undefined) => Promise<Page<T>>,
): PagedAsyncIterableIterator<T> {
  async function* pages(settings: PageSettings = {}): AsyncIterableIterator<Page<T>> {
    let token = settings.continuationToken
    do {
      const page = await fetchPage(token, settings.maxPageSize)
      yield page
      token = page.continuationToken
    } while (token)
  }

  async function* items(): AsyncIterableIterator<T> {
    for await (const page of pages()) yield* page.items
  }

  const iterator = items()
  return {
    next: () => iterator.next(),
    [Symbol.asyncIterator]() {
      return this
    },
    byPage: (settings?: PageSettings) => pages(settings),
  }
}
