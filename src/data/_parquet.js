// Shared helper for encoding loader rows as Parquet instead of raw JSON —
// the STMO usage query alone is ~335k rows / 69MB as JSON but ~3MB as
// Parquet (dictionary-encoded, compressed columns), and large JSON payloads
// were failing to load client-side once deployed (fine on the loopback dev
// server, but not over the network). Client side reads it back via
// FileAttachment(...).parquet(), which Framework backs with the same
// apache-arrow/parquet-wasm pair used here.
import {tableFromJSON, tableToIPC} from "apache-arrow";
import {Table, writeParquet} from "parquet-wasm/node";

export function rowsToParquet(rows) {
  const ipc = tableToIPC(tableFromJSON(rows), "stream");
  return Buffer.from(writeParquet(Table.fromIPCStream(ipc)));
}
