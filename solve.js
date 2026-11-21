// A fast drop-in for csv-reader 1.0.0: run(input) returns csv-reader's reading of the case's input {text, header},
// the JSON value {columns, rows, errors}, for every input, byte for byte the same answer as the reference.
//
// The semantics are csv-reader 1.0.0's broken-row policy, exactly:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside it is one quote, and
//     each CRLF or lone CR inside it is read as LF); what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (error quote_junk, when anything was appended); a quote that never closes is
//     a literal character and the text after it is read again as unquoted (error unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records after it (every record
//     when header is false), each padded with "" (error short_row, with fields: its field count) or cut (error
//     long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts on (every LF, CRLF
//     and lone CR inside quotes counted), row its record's index in rows, null for the header.
//
// Where the reference walks one character at a time and builds each field a character at a time, this reader keeps
// the same single left-to-right pass but moves in slices: indexOf finds the closing quote of a quoted field (and
// the doubled quotes inside it), and a field's plain stretches are copied with one slice each instead of a
// character at a time. Nothing is kept from one call to the next.

const COMMA_END = 0;
const BREAK_END = 1;
const TEXT_END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field most recently read by parseField.
  let fValue = '';
  let fQuoted = false;

  // Reads unquoted characters onto `initial` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). With isJunk, what it appends past `initial` is a quoted field's junk (quote_junk, pushed
  // when the field ends, after any stray_cr the junk itself met). Returns how the field ended.
  function parseUnquoted(initial, isJunk) {
    let value = initial;
    let seg = pos;
    let ended = TEXT_END;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        // ','
        if (pos > seg) value += text.slice(seg, pos);
        pos += 1;
        ended = COMMA_END;
        break;
      }
      if (c === 10) {
        // LF
        if (pos > seg) value += text.slice(seg, pos);
        pos += 1;
        line += 1;
        ended = BREAK_END;
        break;
      }
      if (c === 13) {
        // CR
        if (text.charCodeAt(pos + 1) === 10) {
          if (pos > seg) value += text.slice(seg, pos);
          pos += 2;
          line += 1;
          ended = BREAK_END;
          break;
        }
        if (pos > seg) value += text.slice(seg, pos);
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        seg = pos;
        continue;
      }
      pos += 1;
    }
    if (ended === TEXT_END && pos > seg) value += text.slice(seg, pos);
    fValue = value;
    if (isJunk && value.length > initial.length) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return ended;
  }

  // Reads one field starting at pos into fValue; returns how it ended.
  function parseField() {
    if (pos < n && text.charCodeAt(pos) === 34) {
      // '"' opens a quoted field: find its closing quote, the next quote that is not doubled.
      fQuoted = true;
      const open = pos;
      const openLine = line;
      let scan = pos + 1;
      let close = -1;
      for (;;) {
        const q = text.indexOf('"', scan);
        if (q === -1) break;
        if (text.charCodeAt(q + 1) === 34) {
          scan = q + 2;
          continue;
        }
        close = q;
        break;
      }
      if (close === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return parseUnquoted('"', false);
      }
      // The field's value is the region between the quotes, with "" read as one quote and each CRLF or lone CR
      // read as LF. A region holding neither a quote nor a CR is the value as it stands (its LFs still count).
      const rStart = open + 1;
      let value;
      if (close === rStart) {
        value = '';
      } else {
        const region = text.slice(rStart, close);
        if (region.indexOf('"') === -1 && region.indexOf('\r') === -1) {
          value = region;
          let i = region.indexOf('\n');
          while (i !== -1) {
            line += 1;
            i = region.indexOf('\n', i + 1);
          }
        } else {
          let v = '';
          let seg = rStart;
          let p = rStart;
          while (p < close) {
            const c = text.charCodeAt(p);
            if (c === 34) {
              // A doubled quote inside the region: one quote in the value.
              if (p > seg) v += text.slice(seg, p);
              v += '"';
              p += text.charCodeAt(p + 1) === 34 ? 2 : 1;
              seg = p;
              continue;
            }
            if (c === 13) {
              // CRLF and a lone CR inside quotes are each one LF.
              if (p > seg) v += text.slice(seg, p);
              v += '\n';
              line += 1;
              p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
              seg = p;
              continue;
            }
            if (c === 10) line += 1;
            p += 1;
          }
          if (p > seg) v += text.slice(seg, p);
          value = v;
        }
      }
      pos = close + 1;
      if (pos >= n) {
        fValue = value;
        return TEXT_END;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        return COMMA_END;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        return BREAK_END;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        return BREAK_END;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line break.
      return parseUnquoted(value, true);
    }
    fQuoted = false;
    return parseUnquoted('', false);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    do {
      ended = parseField();
      fields.push(fValue);
    } while (ended === COMMA_END);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !fQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
