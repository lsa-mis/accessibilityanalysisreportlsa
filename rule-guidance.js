/* DRAFT for team review: who fixes each Siteimprove rule and how. Edit freely.
 * Written as a first pass from the Siteimprove rule titles and descriptions.
 * audience: editors | designers | developers | pdf
 * fixedIn:  "Page content" | "Site theme" | "Uploaded documents"
 */
(function (root) {
  const RuleGuidance = {
    version: 1,
    draft: true,
    audiences: {
      editors: "Content editors",
      designers: "Designers",
      developers: "Web developers",
      pdf: "PDF authors"
    },
    rules: {
      "1": {
        audience: "editors", fixedIn: "Page content",
        plain: "Page has no title",
        why: "Screen reader users hear the page title first, and everyone relies on it in browser tabs, bookmarks and search results.",
        fix: [
          "Fill in the page title field in WordPress or AEM before publishing.",
          "Make the title describe the page, e.g. \"Graduate Admissions – Department of History\"."
        ]
      },
      "2": {
        audience: "editors", fixedIn: "Page content",
        plain: "Image has no alt text",
        why: "People who are blind or use screen readers miss whatever information the image carries.",
        fix: [
          "Open the image in the media library or block settings and fill in the Alt text field.",
          "Describe what the image shows or does in a short phrase; skip \"image of\".",
          "If the image is purely decorative, mark it as decorative instead of leaving alt text blank by accident."
        ]
      },
      "4": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Page language is not set",
        why: "Screen readers may read the page with the wrong accent and pronunciation, making it hard to understand.",
        fix: [
          "Set lang=\"en\" (or the right language) on the html element in the site theme or page template.",
          "Check the WordPress or AEM site language setting is filled in."
        ]
      },
      "7": {
        audience: "editors", fixedIn: "Page content",
        plain: "Language code on a passage is mistyped",
        why: "Screen readers can't switch pronunciation for foreign-language passages when the language code is wrong.",
        fix: [
          "Find the passage marked as another language and correct its code (e.g. \"es\" for Spanish, \"fr\" for French).",
          "If you didn't mean to mark a language, remove the setting; ask web developers if it comes from the theme."
        ]
      },
      "8": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Form field has no label",
        why: "Screen reader and voice control users can't tell what to type into the field.",
        fix: [
          "Give every field a visible label connected to it; a placeholder alone is not enough.",
          "For forms built with a form plugin, fill in each field's Label setting and don't hide it.",
          "Check site-wide search boxes in the theme header too."
        ]
      },
      "9": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Page refreshes or redirects on its own",
        why: "People who read slowly or use screen readers can lose their place or be moved before they finish.",
        fix: [
          "Replace timed meta refresh redirects with a server-side redirect.",
          "If a page must update, let the user choose when to refresh."
        ]
      },
      "10": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Form autofill hint is invalid",
        why: "People with memory, motor or cognitive disabilities rely on browsers autofilling their name, email and address.",
        fix: [
          "Correct the autocomplete values on form fields to standard ones like \"email\", \"given-name\" or \"tel\".",
          "In form plugins, check field settings for an autocomplete option and pick from the list."
        ]
      },
      "11": {
        audience: "editors", fixedIn: "Page content",
        plain: "Link has no text",
        why: "Screen reader users hear only \"link\" with no idea where it goes.",
        fix: [
          "Make sure every link has readable text; remove empty links left behind after editing.",
          "If the link is an image or icon, give the image alt text that says where the link goes.",
          "If the link is in the header, footer or a theme component, ask web developers to add a label."
        ]
      },
      "12": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Button has no text",
        why: "Screen reader and voice control users can't tell what the button does or how to activate it.",
        fix: [
          "Add a text label to icon-only buttons (menu, search, close, play) in the theme.",
          "Check carousels, accordions and other widgets for buttons that show only an icon."
        ]
      },
      "13": {
        audience: "editors", fixedIn: "Page content",
        plain: "Embedded frame has no title",
        why: "Screen reader users can't tell what an embedded video, map or form is before entering it.",
        fix: [
          "Add a title to embedded content, e.g. title=\"Campus map\" or \"Video: Welcome to LSA\".",
          "Use the embed block's title or caption setting where available."
        ]
      },
      "14": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Hidden label doesn't match visible label",
        why: "Voice control users say what they see on screen, and the command fails when the hidden name is different.",
        fix: [
          "Make the hidden label on buttons and links start with, or contain, the visible text.",
          "Remove extra hidden labels added by plugins or themes when the visible text is already clear."
        ]
      },
      "16": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Interactive widget is missing required details",
        why: "Screen reader users don't get the state of widgets like sliders, tabs or checkboxes.",
        fix: [
          "Add the required ARIA attributes for the widget's role (for example a value on sliders).",
          "Prefer standard HTML controls, which come with the right information built in."
        ]
      },
      "17": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Hidden section can still be reached by keyboard",
        why: "Keyboard and screen reader users land on items they can't see or hear, and get lost.",
        fix: [
          "When hiding a menu or panel, make its links and buttons unfocusable too (e.g. use the hidden or inert attribute).",
          "Check slide-out menus, modals and carousels in the theme."
        ]
      },
      "18": {
        audience: "developers", fixedIn: "Site theme",
        plain: "ARIA attribute used on the wrong element",
        why: "Screen readers may ignore or misreport elements with unsupported ARIA attributes.",
        fix: [
          "Remove ARIA attributes that aren't allowed on that element, or use an element that supports them.",
          "Check theme templates and plugins that generate the markup."
        ]
      },
      "19": {
        audience: "developers", fixedIn: "Site theme",
        plain: "ARIA attribute has an invalid value",
        why: "Screen readers may report the wrong state, such as a menu being open when it is closed.",
        fix: [
          "Correct the ARIA value to an allowed one (e.g. aria-expanded=\"true\" or \"false\").",
          "Make sure scripts that update the value use valid values."
        ]
      },
      "20": {
        audience: "developers", fixedIn: "Site theme",
        plain: "ARIA attribute name is misspelled",
        why: "Assistive technology ignores the attribute, so the information it was meant to give is lost.",
        fix: [
          "Fix the misspelled aria- attribute or remove it.",
          "Search theme templates and custom HTML blocks for the misspelling."
        ]
      },
      "21": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Element has an invalid role mixed with valid ones",
        why: "Assistive technology may fall back to a role that doesn't describe the element correctly.",
        fix: [
          "Remove role values that don't exist in ARIA and keep a single correct role."
        ]
      },
      "28": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Image button has no alt text",
        why: "Screen reader users can't tell what an image used as a button does.",
        fix: [
          "Add alt text to image buttons describing the action, e.g. \"Search\" or \"Submit\".",
          "Consider replacing image buttons with regular text buttons."
        ]
      },
      "40": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Page region has no name",
        why: "Screen reader users navigating by region hear \"region\" with no idea what it contains.",
        fix: [
          "Give each element with role=\"region\" a label, e.g. by pointing aria-labelledby to its heading.",
          "If the section doesn't need to be a landmark, remove the region role."
        ]
      },
      "41": {
        audience: "editors", fixedIn: "Page content",
        plain: "Same link text goes to different places",
        why: "Screen reader users listing links can't tell apart several \"Read more\" links that go to different pages.",
        fix: [
          "Make link text describe the destination, e.g. \"Read more about the 2026 Writing Prize\".",
          "Avoid repeating generic phrases like \"Click here\" or \"Learn more\" on one page."
        ]
      },
      "42": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Widget part is outside its parent widget",
        why: "Screen readers can't explain items like tabs or list items that aren't inside the right container.",
        fix: [
          "Place child roles inside their required parent (e.g. role=\"tab\" inside role=\"tablist\").",
          "Check custom menus, tabs and lists built in the theme or plugins."
        ]
      },
      "43": {
        audience: "editors", fixedIn: "Page content",
        plain: "Icon or graphic (SVG) has no alt text",
        why: "Screen reader users miss information shown only in the graphic.",
        fix: [
          "Add a text description to meaningful SVG graphics, or mark them decorative.",
          "If the SVG is a theme icon, ask web developers to add a label or hide it."
        ]
      },
      "45": {
        audience: "editors", fixedIn: "Page content",
        plain: "Table cells point to the wrong headers",
        why: "Screen reader users hear the wrong column or row name when moving through table data.",
        fix: [
          "Rebuild complex tables with the table editor's header row/column settings instead of hand-written headers.",
          "If you must use custom HTML, make each cell's headers value match a real header cell id."
        ]
      },
      "46": {
        audience: "editors", fixedIn: "Page content",
        plain: "Table header has no data under it",
        why: "Screen reader users get confusing table announcements when headers don't belong to any cells.",
        fix: [
          "Remove empty header cells or turn them into regular cells.",
          "Use tables only for data; don't use them to lay out the page."
        ]
      },
      "47": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Zooming is blocked on mobile",
        why: "People with low vision can't pinch-zoom to read the page on phones and tablets.",
        fix: [
          "Remove user-scalable=no and maximum-scale limits from the viewport meta tag in the theme."
        ]
      },
      "53": {
        audience: "editors", fixedIn: "Page content",
        plain: "Heading levels are skipped",
        why: "Screen reader users navigate by headings and get confused when levels jump, e.g. from H2 to H4.",
        fix: [
          "Use headings in order: one H1, then H2 for sections, H3 for sub-sections.",
          "Pick heading levels for structure, not for size; change the look with styles instead."
        ]
      },
      "57": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Content sits outside the page’s landmark regions",
        why: "Screen reader users who jump between page regions (header, main, footer) can miss this content.",
        fix: [
          "Make sure the theme wraps all content in header, nav, main and footer regions.",
          "Check banners, alerts and cookie notices that are added outside the main template."
        ]
      },
      "59": {
        audience: "editors", fixedIn: "Page content",
        plain: "Page has no headings",
        why: "Screen reader users can't skim or jump around the page, and everyone finds long text harder to scan.",
        fix: [
          "Add headings to break up content, using the Heading block or format menu.",
          "Don't fake headings with bold text."
        ]
      },
      "60": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Group of checkboxes or radio buttons has no label",
        why: "Screen reader users hear the options but not the question they answer.",
        fix: [
          "Wrap related options in a fieldset with a legend that states the question.",
          "In form plugins, fill in the field group's label and keep it visible."
        ]
      },
      "61": {
        audience: "editors", fixedIn: "Page content",
        plain: "Page doesn't start with a main heading",
        why: "Screen reader users expect an H1 that tells them what the page is about.",
        fix: [
          "Give each page one H1 that matches the page's topic, usually the page title.",
          "If the theme should output the title as H1 but doesn't, tell web developers."
        ]
      },
      "62": {
        audience: "designers", fixedIn: "Site theme",
        plain: "Links look the same as normal text",
        why: "People with color blindness or low vision can't spot links that are shown only by color.",
        fix: [
          "Underline links in body text in the theme styles.",
          "If links aren't underlined, make them at least 3:1 contrast with surrounding text and add an underline on hover and focus."
        ]
      },
      "63": {
        audience: "editors", fixedIn: "Page content",
        plain: "Embedded object has no text alternative",
        why: "Screen reader users can't tell what an embedded file or media object is.",
        fix: [
          "Add a text description or link to the content next to the embedded object.",
          "Prefer embedding with a supported block (video, PDF link) instead of an object tag."
        ]
      },
      "64": {
        audience: "editors", fixedIn: "Page content",
        plain: "Empty heading",
        why: "Screen reader users hear a heading with nothing in it, which is confusing when navigating.",
        fix: [
          "Delete empty heading blocks, often left after copying and pasting or removing text.",
          "If you used an empty heading for spacing, use a spacer block instead."
        ]
      },
      "66": {
        audience: "designers", fixedIn: "Site theme",
        plain: "Text contrast below the higher (AAA) standard",
        why: "People with low vision or older eyes find low-contrast text hard to read.",
        fix: [
          "Aim for 7:1 contrast for body text (4.5:1 for large text) in the theme's color palette.",
          "This is a Level AAA goal; fix Level AA contrast (rule 69) first."
        ]
      },
      "67": {
        audience: "editors", fixedIn: "Page content",
        plain: "Decorative image is still announced",
        why: "Screen reader users hear clutter from images that were meant to be skipped.",
        fix: [
          "Use the image's \"decorative\" option so its alt text is empty and it has no title.",
          "If the image is in the theme, ask web developers to hide it from screen readers."
        ]
      },
      "68": {
        audience: "developers", fixedIn: "Site theme",
        plain: "List or menu container is empty",
        why: "Screen readers announce a list, menu or table that has nothing in it.",
        fix: [
          "Remove empty containers or only output them when they have items.",
          "Check menus and widgets that can render with no items."
        ]
      },
      "69": {
        audience: "designers", fixedIn: "Site theme",
        plain: "Text doesn't stand out enough from its background",
        why: "People with low vision, color blindness or screen glare can't read low-contrast text.",
        fix: [
          "Make text at least 4.5:1 contrast with its background (3:1 for large text) in the theme colors.",
          "Editors: don't place text over busy images or pick light text colors in the editor.",
          "Use a contrast checker such as WebAIM's when choosing colors."
        ]
      },
      "70": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Outdated HTML element in use",
        why: "Old elements like marquee or font may not work with assistive technology.",
        fix: [
          "Replace outdated elements with modern HTML and CSS.",
          "Editors: remove old pasted code from custom HTML blocks."
        ]
      },
      "71": {
        audience: "editors", fixedIn: "Page content",
        plain: "Justified text with uneven spacing",
        why: "People with dyslexia find uneven gaps between words hard to read.",
        fix: [
          "Align text left instead of using \"Justify\" in the editor.",
          "If the theme justifies text, ask designers to change it."
        ]
      },
      "72": {
        audience: "editors", fixedIn: "Page content",
        plain: "Whole paragraph in capital letters",
        why: "All-caps text is harder to read, especially for people with dyslexia or low vision.",
        fix: [
          "Write paragraphs in normal sentence case.",
          "Keep uppercase styling for short labels only; ask designers if the theme forces it."
        ]
      },
      "73": {
        audience: "designers", fixedIn: "Site theme",
        plain: "Lines of text are too close together",
        why: "Tight line spacing makes text harder to track for people with dyslexia or low vision.",
        fix: [
          "Set paragraph line spacing to at least 1.5 in the theme styles."
        ]
      },
      "74": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Text size is fixed and may not resize",
        why: "People who enlarge text in their browser may find it doesn't grow.",
        fix: [
          "Use relative units (rem, em, %) for font sizes in the theme CSS instead of px or pt.",
          "Editors: avoid setting fixed pixel font sizes in custom HTML."
        ]
      },
      "75": {
        audience: "designers", fixedIn: "Site theme",
        plain: "Text is too small",
        why: "Very small text is hard to read for people with low vision and on mobile screens.",
        fix: [
          "Raise minimum font size in the theme; body text should be about 16px.",
          "Check footers, captions and fine print."
        ]
      },
      "76": {
        audience: "editors", fixedIn: "Page content",
        plain: "Table header not marked as a header",
        why: "Screen reader users don't hear column or row names when reading table data.",
        fix: [
          "Turn on the header row (and header column if needed) in the table block settings.",
          "Don't just make the first row bold; mark it as a header."
        ]
      },
      "77": {
        audience: "editors", fixedIn: "Page content",
        plain: "Table data has no column or row headers",
        why: "Screen reader users hear numbers and words without knowing which column or row they belong to.",
        fix: [
          "Turn on the header row or column in the table block settings.",
          "For layout-only tables, rebuild the content with columns blocks instead."
        ]
      },
      "78": {
        audience: "editors", fixedIn: "Page content",
        plain: "Heading with no content after it",
        why: "Screen reader users jumping to a heading find nothing under it.",
        fix: [
          "Add content under the heading or remove the heading.",
          "Don't use headings just to make text big or bold."
        ]
      },
      "79": {
        audience: "editors", fixedIn: "Page content",
        plain: "Preformatted text used for layout",
        why: "Preformatted text doesn't reflow on small screens or when zoomed, and can't be adjusted for readability.",
        fix: [
          "Use regular paragraphs, lists or tables instead of the Preformatted or Code block.",
          "Keep preformatted blocks for real code samples only."
        ]
      },
      "80": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Line spacing is fixed and may not adjust",
        why: "People who change spacing or enlarge text may find lines overlap.",
        fix: [
          "Set line-height without units (e.g. 1.5) in the theme CSS instead of px or pt."
        ]
      },
      "81": {
        audience: "editors", fixedIn: "Page content",
        plain: "Links with the same text go to different places",
        why: "Screen reader users can't tell which \"Learn more\" or \"Click here\" link to choose.",
        fix: [
          "Rewrite link text to name the destination, e.g. \"Apply to the Honors Program\".",
          "Make sure links with the same text go to the same page."
        ]
      },
      "84": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Scrolling box can't be used with a keyboard",
        why: "Keyboard users can't scroll to read the hidden content.",
        fix: [
          "Make scrollable boxes focusable (tabindex=\"0\") and give them a label.",
          "Editors: avoid fixed-height boxes in custom HTML; let content expand."
        ]
      },
      "85": {
        audience: "editors", fixedIn: "Page content",
        plain: "Whole paragraph in italics",
        why: "Long italic text is harder to read for people with dyslexia or low vision.",
        fix: [
          "Use italics only for short phrases, titles or emphasis.",
          "Remove italic formatting from whole paragraphs; use a quote block for quotations."
        ]
      },
      "86": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Decorative element is still announced",
        why: "Screen reader users hear elements that were meant to be skipped.",
        fix: [
          "Remove focusability or extra ARIA from elements marked role=\"presentation\" or \"none\".",
          "Or hide purely decorative elements with aria-hidden=\"true\"."
        ]
      },
      "87": {
        audience: "developers", fixedIn: "Site theme",
        plain: "No \"Skip to main content\" link",
        why: "Keyboard users must tab through the whole header and menu on every page.",
        fix: [
          "Add a \"Skip to main content\" link as the first item in the theme header.",
          "Make it visible when it receives keyboard focus and point it to the main content area."
        ]
      },
      "90": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Focusable item hidden inside a simple control",
        why: "Keyboard and screen reader users reach items inside controls like buttons that should be a single unit.",
        fix: [
          "Don't put links or other focusable items inside a button, image or similar control.",
          "Restructure the component so each interactive item stands on its own."
        ]
      },
      "96": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Page refreshes or redirects without warning",
        why: "People who read slowly or use screen readers can be interrupted or lose their place.",
        fix: [
          "Replace meta refresh redirects with server-side redirects.",
          "Never auto-refresh a page; offer a refresh button instead."
        ]
      },
      "110": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Element's role is not a real ARIA role",
        why: "Assistive technology ignores the role, so users don't learn what the element is.",
        fix: [
          "Fix the misspelled role or replace it with a valid one.",
          "Better still, use the matching HTML element (button, nav, list) instead of a role."
        ]
      },
      "111": {
        audience: "designers", fixedIn: "Site theme",
        plain: "Buttons or links smaller than 44×44 pixels",
        why: "People with tremors, limited dexterity or on touch screens find small targets hard to tap.",
        fix: [
          "Make buttons, icons and menu links at least 44 by 44 pixels in the theme.",
          "This is a Level AAA goal; fix the Level AA size rule (113) first."
        ]
      },
      "113": {
        audience: "designers", fixedIn: "Site theme",
        plain: "Buttons or links too small or too close together",
        why: "People with tremors, limited dexterity or on touch screens may tap the wrong item.",
        fix: [
          "Make clickable items at least 24 by 24 pixels, or leave enough space around them.",
          "Check social icons, pagination and footer links in the theme."
        ]
      },
      "116": {
        audience: "developers", fixedIn: "Site theme",
        plain: "Expand/collapse toggle has no label",
        why: "Screen reader users can't tell what an expandable section contains before opening it.",
        fix: [
          "Give every summary (accordion toggle) clear text describing the section.",
          "Editors: fill in the title of each Details or accordion block."
        ]
      }
    }
  };

  root.RuleGuidance = RuleGuidance;
  if (typeof module !== "undefined" && module.exports) module.exports = RuleGuidance;
})(typeof window !== "undefined" ? window : globalThis);
