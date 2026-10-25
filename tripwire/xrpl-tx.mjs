// Leaderboard source tag for XRPL *mainnet* transactions (shown in the hackathon dashboard).
// SourceTag is a native field on XRPL transactions; it does not exist on the XRPL EVM Testnet
// voucher flow that AP4M uses, so this only matters when a native XRPL transaction is built.
export const SOURCE_TAG = 2610250006;

/**
 * Return a copy of an unsigned XRPL transaction with SourceTag set.
 * Throws if the transaction already carries a different SourceTag. Never signs or submits.
 */
export function withSourceTag(tx) {
  if (tx.SourceTag !== undefined && tx.SourceTag !== SOURCE_TAG) {
    throw new Error(`transaction already has SourceTag ${tx.SourceTag}; refusing to overwrite with ${SOURCE_TAG}`);
  }
  return { ...tx, SourceTag: SOURCE_TAG };
}
