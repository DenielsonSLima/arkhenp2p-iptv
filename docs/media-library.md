# Favoritos e histórico por conta

`web/media-library.js` possui os mapas de favoritos e histórico usados por `web/app.js`. A chamada `activate(provider, account.libraryId)` limpa os mapas da conta anterior e carrega somente a chave da conta conectada.

- `account.libraryId` deve ser o identificador opaco de 64 caracteres hexadecimais emitido pelo backend; usuário mascarado não serve como identidade.
- Com identificador válido, as chaves são `orbit.library.v3.<provider>.<libraryId>.favorites`, `.history` e `.adopted`.
- Na compatibilidade com um servidor antigo que ainda não emite esse campo, permanecem as chaves `orbit.library.v2.<provider>`. Esse modo antigo não separa contas do mesmo provedor; reinicie o backend atualizado para ativar a separação por conta.
- Referências temporárias de imagens autenticadas não são persistidas. O catálogo atual fornece novamente as imagens.

## Dados anteriores

Os registros globais `orbit.favorites.v1` / `orbit.history.v1` e os registros v2 ficam intactos. Coincidir o ID e o título prova que o conteúdo existe no catálogo, mas não identifica quem o assistiu. Por isso, o modo v3 não importa automaticamente favoritos ou histórico sem identificação de conta.

A única migração automática de dados compartilhados é o histórico cujo `libraryId` coincide exatamente com a conta conectada. Cada adoção ganha uma marca por conta, impedindo que um registro removido reapareça no próximo login.

`legacySummary()` informa se há dados antigos disponíveis. Em **Configurações → Perfil**, a ação **Importar lista deste navegador** explica que esses registros não identificavam a conta e pede uma escolha explícita pelo próprio clique. `importLegacy()` autoriza somente a conta conectada: copia os registros encontrados por ID, tipo e título no catálogo atual, sem sobrescrever seus registros existentes. Títulos de páginas ainda não recebidas são conferidos por `migrate(catalog)` quando o catálogo carregar. Histórico identificado como pertencente a outra conta nunca é importado.

A autorização e as marcas de adoção são persistidas em `.adopted`. A importação não apaga ou modifica os registros v1/v2, não se transfere para outra conta e não recria favoritos/histórico que o usuário já removeu após importá-los.

## Integração e testes

`SettingsTools` recebe a mesma instância `mediaLibrary` usada pelo aplicativo e a encaminha ao perfil. Depois do clique, `onLibraryChange` atualiza as listas do catálogo. A importação não exige um segundo diálogo de confirmação.

Execute `node --test tests/media-library.test.mjs tests/settings-library-import.test.mjs`. Os casos verificam contas diferentes no mesmo provedor, compatibilidade v2, ausência de atribuição indevida dos dados antigos, migração com identificação comprovada, importação deliberada, páginas tardias e remoções persistentes.
