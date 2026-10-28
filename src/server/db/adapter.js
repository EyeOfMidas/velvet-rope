// The slice of a synchronous SQLite API that velvet-rope uses, as a base class. Each driver gets a
// subclass that says how to find, open and recognise its database; everything else in the package
// talks to this interface and never to a driver.
//
//   exec(sql)               run statements, no result
//   prepare(sql)            -> statement: run(...params) -> { changes }, get(...), all(...), pluck()
//   transaction(fn)         -> function that runs fn atomically (nested calls use savepoints)
//   pragma(text)            -> rows
//   close()
//   raw                     the driver's own handle, for anything beyond this interface
//
// Rows are plain objects, BLOB columns are Buffers and integers are numbers, whichever driver is
// underneath.
export class SqliteAdapter {
  /** Short name used to pick a driver explicitly: openDatabase(path, { driver }). */
  static driver = 'unknown';

  /** The driver's database constructor, or undefined when it isn't installed. */
  static load() {
    throw new Error(`${this.name} must implement load()`);
  }

  /** Whether `raw` is a database handle from this driver. */
  static matches() {
    throw new Error(`${this.name} must implement matches()`);
  }

  static open(path) {
    const Database = this.load();
    if (!Database) throw new Error(`velvet-rope: the ${this.driver} driver isn't available`);
    return new this(new Database(path));
  }

  constructor(raw) {
    this.raw = raw;
  }

  exec(sql) {
    this.raw.exec(sql);
    return this;
  }

  prepare() {
    throw new Error(`${this.constructor.name} must implement prepare()`);
  }

  transaction() {
    throw new Error(`${this.constructor.name} must implement transaction()`);
  }

  pragma() {
    throw new Error(`${this.constructor.name} must implement pragma()`);
  }

  close() {
    this.raw.close();
  }
}
