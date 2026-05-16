# Accessibility Advanced Patterns

## Audit Workflow

1. Run automated checks first with `axe-core`, `pa11y`, or Lighthouse.
2. Verify keyboard navigation manually.
3. Check screen reader behavior for labels, headings, landmarks, and live regions.
4. Validate contrast, zoom, reflow, and reduced motion behavior.
5. Capture remediation notes with the exact WCAG criterion when possible.

## Common Violations by Impact

### Critical

- Missing alt text for functional images
- No keyboard access to interactive elements
- Missing form labels
- Auto-playing media without controls

### Serious

- Insufficient color contrast
- Missing skip links
- Inaccessible custom widgets
- Missing page titles

### Moderate

- Missing language attribute
- Unclear link text
- Missing landmarks
- Improper heading hierarchy

## Remediation Patterns

### Missing Form Labels

```html
<label for="email">Email address</label> <input id="email" type="email" />
```

### Insufficient Color Contrast

```css
.text {
  color: #595959;
}
```

### Keyboard Navigation for Custom Controls

```javascript
class AccessibleDropdown extends HTMLElement {
  connectedCallback() {
    this.setAttribute("tabindex", "0");
    this.setAttribute("role", "combobox");
    this.setAttribute("aria-expanded", "false");

    this.addEventListener("keydown", (e) => {
      switch (e.key) {
        case "Enter":
        case " ":
          this.toggle();
          e.preventDefault();
          break;
        case "Escape":
          this.close();
          break;
      }
    });
  }
}
```

### Skip Navigation Link

```tsx
<a href="#main" className="skip-link">Skip to main content</a>
<main id="main">...</main>
```

### Live Region Announcements

```tsx
<div role="status" aria-live="polite">
  3 items added to cart
</div>
```

## Testing Tools

- Automated: `axe DevTools`, `WAVE`, `Lighthouse`
- Manual: `VoiceOver`, `NVDA`, `JAWS`, `TalkBack`
- CLI: `npx @axe-core/cli`, `npx pa11y`, `lighthouse --only-categories=accessibility`

## Notes

- Prefer native HTML over ARIA when both solve the problem.
- Do not rely only on automated testing.
- Keep accessible patterns consistent across the design system.
