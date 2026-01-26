'use strict';

const obsidian = require('obsidian');
const { EditorView, Decoration, ViewPlugin } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');

// Decoration for timeblock styling in Live Preview
const timeblockDecoration = Decoration.mark({ class: 'timeblock' });

// ViewPlugin to find and decorate timeblocks
// Note: Due dates are handled by the Tasks plugin - we just style them via CSS
const timeblockViewPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.buildDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view) {
      const builder = new RangeSetBuilder();
      const timePattern = /\d{2}:\d{2} - \d{2}:\d{2}/g;

      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        let match;

        while ((match = timePattern.exec(text)) !== null) {
          const start = from + match.index;
          const end = start + match[0].length;
          builder.add(start, end, timeblockDecoration);
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

class TimeblockFormatterPlugin extends obsidian.Plugin {
  async onload() {
    console.log('Timeblock Formatter: loaded');

    // Register CodeMirror extension for Live Preview styling
    this.registerEditorExtension([timeblockViewPlugin]);

    // Register markdown post-processor for Reading View styling
    // Note: Due dates are styled via CSS targeting Tasks plugin classes
    this.registerMarkdownPostProcessor((element, context) => {
      this.styleTimeblocks(element);
    });

    // Register event for file modification (time format normalization)
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        // Only process markdown files in Daily folder
        if (file.extension === 'md' && file.path.includes('00 - Daily/')) {
          this.formatTimeblocks(file);
        }
      })
    );

    // Add command for manual formatting
    this.addCommand({
      id: 'format-timeblocks',
      name: 'Format timeblocks in current file',
      editorCallback: (editor, view) => {
        const content = editor.getValue();
        const formatted = this.formatContent(content);
        if (content !== formatted) {
          editor.setValue(formatted);
        }
      }
    });
  }

  // Style timeblocks in Reading View by wrapping them in spans
  styleTimeblocks(element) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    const nodesToProcess = [];
    let node;
    while (node = walker.nextNode()) {
      if (node.parentElement?.closest('.timeblock, code, pre')) continue;
      if (/\d{2}:\d{2} - \d{2}:\d{2}/.test(node.textContent)) {
        nodesToProcess.push(node);
      }
    }

    for (const textNode of nodesToProcess) {
      const text = textNode.textContent;
      const timePattern = /(\d{2}:\d{2} - \d{2}:\d{2})/g;

      if (timePattern.test(text)) {
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;

        timePattern.lastIndex = 0;
        while ((match = timePattern.exec(text)) !== null) {
          if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
          }
          const span = document.createElement('span');
          span.className = 'timeblock';
          span.textContent = match[1];
          fragment.appendChild(span);
          lastIndex = timePattern.lastIndex;
        }

        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        textNode.parentNode.replaceChild(fragment, textNode);
      }
    }
  }

  async formatTimeblocks(file) {
    const content = await this.app.vault.read(file);
    const formatted = this.formatContent(content);

    if (content !== formatted) {
      await this.app.vault.modify(file, formatted);
    }
  }

  formatContent(content) {
    // Process line by line to safely handle empty tasks
    const lines = content.split('\n');
    const processedLines = lines.map(line => {
      // Skip empty task lines - don't apply any transformations
      // This prevents the formatter from incorrectly pulling content from adjacent lines
      if (/^- \[.\]\s*$/.test(line)) {
        return line;
      }
      // Skip calendar events [c] - they already have properly formatted times from ICS
      if (/^- \[c\]/.test(line)) {
        return line;
      }
      return this.formatLine(line);
    });

    return processedLines.join('\n');
  }

  formatLine(line) {
    let result = line;

    // Strip any existing span wrappers (cleanup from previous version)
    result = result.replace(/<span class="timeblock">(\d{2}:\d{2} - \d{2}:\d{2})<\/span>/g, '$1');

    const inferHour = (hour) => {
      if (hour >= 1 && hour <= 5) return hour + 12;
      if (hour >= 6 && hour <= 8) return hour + 12;
      return hour;
    };

    const parseTime = (timeStr, applyInference = false) => {
      timeStr = timeStr.trim().toLowerCase();
      let hours, minutes = 0;
      let explicitPeriod = false;

      if (/^\d{3,4}$/.test(timeStr)) {
        const num = timeStr.padStart(4, '0');
        hours = parseInt(num.slice(0, 2));
        minutes = parseInt(num.slice(2));
        explicitPeriod = true;
      }
      else if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
        const parts = timeStr.split(':');
        hours = parseInt(parts[0]);
        minutes = parseInt(parts[1]);
        if (hours >= 13) explicitPeriod = true;
      }
      else if (/^\d{1,2}(?::\d{2})?\s*(?:am?|pm?)$/i.test(timeStr)) {
        const match = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am?|pm?)$/i);
        hours = parseInt(match[1]);
        minutes = match[2] ? parseInt(match[2]) : 0;
        const isPM = match[3].toLowerCase().startsWith('p');
        if (isPM && hours !== 12) hours += 12;
        if (!isPM && hours === 12) hours = 0;
        explicitPeriod = true;
      }
      else if (/^\d{1,2}$/.test(timeStr)) {
        hours = parseInt(timeStr);
        if (applyInference && hours <= 12) {
          hours = inferHour(hours);
        }
      }
      else {
        return null;
      }

      if (!explicitPeriod && applyInference && hours <= 12) {
        hours = inferHour(hours);
      }

      if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    };

    const parseCompactTime = (str) => {
      const num = parseInt(str);
      if (str.length === 3) {
        return { hours: Math.floor(num / 100), minutes: num % 100 };
      } else if (str.length === 4) {
        return { hours: Math.floor(num / 100), minutes: num % 100 };
      } else if (str.length <= 2) {
        return { hours: num, minutes: 0 };
      }
      return null;
    };

    const patterns = [
      {
        regex: /\b(\d{4})\s*[-–]\s*(\d{4})\b/g,
        replace: (match, t1, t2) => {
          const start = parseTime(t1);
          const end = parseTime(t2);
          return (start && end) ? `${start} - ${end}` : match;
        }
      },
      {
        regex: /(\d{1,2}(?::\d{2})?\s*(?:am?|pm?))\s*[-–]\s*(\d{1,2}(?::\d{2})?\s*(?:am?|pm?))/gi,
        replace: (match, t1, t2) => {
          const start = parseTime(t1);
          const end = parseTime(t2);
          return (start && end) ? `${start} - ${end}` : match;
        }
      },
      {
        regex: /\b(\d{1,2}(?::\d{2})?)\s*[-–]\s*(\d{1,2}(?::\d{2})?\s*(?:am?|pm?))/gi,
        replace: (match, t1, t2) => {
          const periodMatch = t2.match(/(am?|pm?)/i);
          const period = periodMatch ? periodMatch[1] : '';
          const start = parseTime(t1 + period);
          const end = parseTime(t2);
          return (start && end) ? `${start} - ${end}` : match;
        }
      },
      {
        // Match compact time ranges at end of line, but NOT dates like 2026-01-19
        regex: /\b(\d{1,4})[-–](\d{1,4})(\s*$)/gm,
        replace: (match, t1, t2, suffix, offset, string) => {
          // Check if this looks like part of a date (preceded by YYYY-)
          const before = string.slice(Math.max(0, offset - 5), offset);
          if (/\d{4}-$/.test(before)) {
            return match; // This is part of a date, don't convert
          }
          const time1 = parseCompactTime(t1);
          const time2 = parseCompactTime(t2);
          if (!time1 || !time2) return match;
          if (time1.minutes > 59 || time2.minutes > 59) return match;

          let h1 = time1.hours;
          let h2 = time2.hours;

          if (h1 <= 12) h1 = inferHour(h1);
          if (h2 <= 12) h2 = inferHour(h2);

          if (h1 < 0 || h1 > 23 || h2 < 0 || h2 > 23) return match;

          const start = `${String(h1).padStart(2, '0')}:${String(time1.minutes).padStart(2, '0')}`;
          const end = `${String(h2).padStart(2, '0')}:${String(time2.minutes).padStart(2, '0')}`;
          return `${start} - ${end}${suffix}`;
        }
      },
      {
        regex: /(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/g,
        replace: (match, t1, t2) => {
          const start = parseTime(t1);
          const end = parseTime(t2);
          return (start && end) ? `${start} - ${end}` : match;
        }
      },
      {
        // Match bare time ranges like "1-3" only after ] or # (not after year like 2026-)
        // Negative lookbehind ensures we don't match dates like 2026-01-19
        regex: /([\]#]\s*)(\d{1,2})\s*[-–]\s*(\d{1,2})(\s*$|\s+)/gm,
        replace: (match, prefix, t1, t2, suffix, offset, string) => {
          // Don't match if this looks like part of a date (preceded by 4-digit year and dash)
          const before = string.slice(Math.max(0, offset - 6), offset);
          if (/\d{4}-$/.test(before)) {
            return match; // This is part of a date like 2026-01-19, don't convert
          }
          const start = parseTime(t1, true);
          const end = parseTime(t2, true);
          if (start && end) {
            return `${prefix}${start} - ${end}${suffix}`;
          }
          return match;
        }
      },
      {
        regex: /([\]#]\s*)(\d{1,2})\s*[-–]\s*(\d{1,2}:\d{2})/g,
        replace: (match, prefix, t1, t2) => {
          const start = parseTime(t1, true);
          const end = parseTime(t2, true);
          if (start && end) {
            return `${prefix}${start} - ${end}`;
          }
          return match;
        }
      },
      // Single start time with no end time -> default to 30 minutes
      // Match patterns like "- [ ] 3p task" or "- [ ] 15:00 task" or "- [ ] 3 task"
      {
        regex: /^(- \[.\] )(\d{1,2}(?::\d{2})?\s*(?:am?|pm?)?)\s+(?!\s*[-–]\s*\d)(.+)$/gim,
        replace: (match, checkbox, timeStr, rest) => {
          // Skip if rest already starts with a timeblock
          if (/^\d{2}:\d{2} - \d{2}:\d{2}/.test(rest.trim())) {
            return match;
          }
          const start = parseTime(timeStr, true);
          if (!start) return match;

          // Calculate end time (30 minutes later)
          const [hours, mins] = start.split(':').map(Number);
          let endMins = mins + 30;
          let endHours = hours;
          if (endMins >= 60) {
            endMins -= 60;
            endHours += 1;
          }
          if (endHours >= 24) endHours -= 24;

          const end = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`;
          return `${checkbox}${start} - ${end} ${rest.trim()}`;
        }
      },
      // Single start time at END of line (e.g., "- [ ] task text 1600" or "- [ ] task 3p")
      // Moves time to front and defaults to 30 minutes
      {
        regex: /^(- \[.\] )(.+)\s+(\d{3,4})\s*$/gm,
        replace: (match, checkbox, taskText, timeStr) => {
          // Skip if task already has a timeblock at start
          if (/^\d{2}:\d{2} - \d{2}:\d{2}/.test(taskText.trim())) {
            return match;
          }
          // Skip if this looks like it could be a year or other non-time number
          if (parseInt(timeStr) > 2359) {
            return match;
          }
          const start = parseTime(timeStr, true);
          if (!start) return match;

          // Calculate end time (30 minutes later)
          const [hours, mins] = start.split(':').map(Number);
          let endMins = mins + 30;
          let endHours = hours;
          if (endMins >= 60) {
            endMins -= 60;
            endHours += 1;
          }
          if (endHours >= 24) endHours -= 24;

          const end = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`;
          return `${checkbox}${start} - ${end} ${taskText.trim()}`;
        }
      },
      // Single time with am/pm at end of line (e.g., "- [ ] task 3p" or "- [ ] task 3pm")
      {
        regex: /^(- \[.\] )(.+)\s+(\d{1,2}(?::\d{2})?\s*(?:am?|pm?))\s*$/gim,
        replace: (match, checkbox, taskText, timeStr) => {
          // Skip if task already has a timeblock at start
          if (/^\d{2}:\d{2} - \d{2}:\d{2}/.test(taskText.trim())) {
            return match;
          }
          const start = parseTime(timeStr, true);
          if (!start) return match;

          // Calculate end time (30 minutes later)
          const [hours, mins] = start.split(':').map(Number);
          let endMins = mins + 30;
          let endHours = hours;
          if (endMins >= 60) {
            endMins -= 60;
            endHours += 1;
          }
          if (endHours >= 24) endHours -= 24;

          const end = `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}`;
          return `${checkbox}${start} - ${end} ${taskText.trim()}`;
        }
      }
    ];

    for (const pattern of patterns) {
      result = result.replace(pattern.regex, pattern.replace);
    }

    // CLEANUP: Remove duplicate timeblocks from task lines
    // If a line has multiple timeblocks, keep only the first one
    result = result.replace(
      /^(- \[.\] )(\d{2}:\d{2} - \d{2}:\d{2}) (.*)$/gm,
      (match, checkbox, firstTimeblock, rest) => {
        // Remove any additional timeblocks from the rest of the line
        const cleanedRest = rest.replace(/\d{2}:\d{2} - \d{2}:\d{2}\s*/g, '').trim();
        return `${checkbox}${firstTimeblock} ${cleanedRest}`;
      }
    );

    // Move timeblocks to the start of tasks (right after checkbox)
    // But ONLY if there isn't already a timeblock at the start
    // Pattern: - [ ] task text ... HH:MM - HH:MM ... -> - [ ] HH:MM - HH:MM task text ...
    result = result.replace(
      /^(- \[.\] )(.+?)(\d{2}:\d{2} - \d{2}:\d{2})(.*)$/gm,
      (match, checkbox, beforeTime, timeblock, afterTime) => {
        // Check if there's already a timeblock at the start (right after checkbox)
        if (/^\d{2}:\d{2} - \d{2}:\d{2}/.test(beforeTime.trim())) {
          // Already has a timeblock at start, don't add another
          return match;
        }
        const trimmedBefore = beforeTime.trim();
        if (trimmedBefore === '') {
          // Already at start, keep as is
          return match;
        }
        // Move timeblock to start, preserve the rest
        const taskContent = (trimmedBefore + afterTime).trim();
        return `${checkbox}${timeblock} ${taskContent}`;
      }
    );

    return result;
  }

  onunload() {
    console.log('Timeblock Formatter: unloaded');
  }
}

module.exports = TimeblockFormatterPlugin;
