import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Modal } from "../Modal";

function getDialog() {
  return screen.getByRole("dialog", { hidden: true });
}

function openTrigger() {
  const trigger = document.createElement("button");
  trigger.textContent = "Open Modal";
  document.body.appendChild(trigger);
  trigger.focus();
  return trigger;
}

function renderModal(props: Omit<React.ComponentProps<typeof Modal>, "children">) {
  return render(
    <Modal {...props}>
      <button data-testid="first-focusable">First</button>
      <button data-testid="middle-focusable">Middle</button>
      <button data-testid="last-focusable">Last</button>
    </Modal>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Modal focus trap", () => {
  it("places initial focus on the dialog container when opened", () => {
    renderModal({ isOpen: true, onClose: jest.fn() });

    const dialog = getDialog();
    expect(dialog).toHaveFocus();
  });

  it("returns focus to the triggering element when closed (#1333)", () => {
    const trigger = openTrigger();

    const { rerender } = renderModal({ isOpen: true, onClose: jest.fn() });

    act(() => {
      rerender(
        <Modal isOpen={false} onClose={jest.fn()}>
          <button>Child</button>
        </Modal>
      );
    });

    expect(trigger).toHaveFocus();

    trigger.remove();
  });

  it("wraps focus forward (Tab) from the last element to the first", () => {
    const onClose = jest.fn();
    renderModal({ isOpen: true, onClose });

    const first = screen.getByTestId("first-focusable");
    const last = screen.getByTestId("last-focusable");

    last.focus();
    fireEvent.keyDown(getDialog(), { key: "Tab" });

    expect(first).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("wraps focus backward (Shift+Tab) from the first element to the last", () => {
    renderModal({ isOpen: true, onClose: jest.fn() });

    const first = screen.getByTestId("first-focusable");
    const last = screen.getByTestId("last-focusable");

    first.focus();
    fireEvent.keyDown(getDialog(), { key: "Tab", shiftKey: true });

    expect(last).toHaveFocus();
  });

  it("does not force focus off the first element with a plain Tab", () => {
    renderModal({ isOpen: true, onClose: jest.fn() });

    const dialog = getDialog();
    const middle = screen.getByTestId("middle-focusable");
    const last = screen.getByTestId("last-focusable");

    // Plain Tab from the last element wraps to the first.
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByTestId("first-focusable")).toHaveFocus();

    // Plain Tab from the first element does not jump backwards; focus is
    // left to the browser's normal movement until the boundary is reached.
    const first = screen.getByTestId("first-focusable");
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(first).toHaveFocus();
    expect(middle).not.toHaveFocus();
  });
});

describe("Modal body scroll lock", () => {
  it("locks body scroll while open and restores it on close (#1333)", () => {
    const { rerender } = renderModal({ isOpen: true, onClose: jest.fn() });

    // Overflow hidden while open
    expect(document.body.style.overflow).toBe("hidden");

    act(() => {
      rerender(
        <Modal isOpen={false} onClose={jest.fn()}>
          <button>Child</button>
        </Modal>
      );
    });

    // Scroll restored (empty string after cleanup)
    expect(document.body.style.overflow).toBe("");
  });
});

describe("Modal dismissal behavior", () => {
  it("closes on Escape when closeOnEscape is true (default)", () => {
    const onClose = jest.fn();
    renderModal({ isOpen: true, onClose });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on Escape when closeOnEscape is false (#1333)", () => {
    const onClose = jest.fn();
    renderModal({ isOpen: true, onClose, closeOnEscape: false });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on overlay click when closeOnOverlayClick is true (default)", () => {
    const onClose = jest.fn();
    renderModal({ isOpen: true, onClose });

    // The overlay wraps the dialog; clicking the outermost overlay element
    // (which has aria-hidden and the position styles) triggers the overlay
    // click handler.
    const overlay = getDialog().parentElement!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on overlay click when closeOnOverlayClick is false (#1333)", () => {
    const onClose = jest.fn();
    renderModal({ isOpen: true, onClose, closeOnOverlayClick: false });

    const overlay = getDialog().parentElement!;
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close when clicking inside the dialog content", () => {
    const onClose = jest.fn();
    renderModal({ isOpen: true, onClose });

    fireEvent.click(screen.getByTestId("middle-focusable"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Modal stacked behavior (#1333)", () => {
  it("closes only the top-most modal when Escape is pressed", () => {
    const onCloseTop = jest.fn();
    const onCloseBottom = jest.fn();

    render(
      <div>
        <Modal isOpen onClose={onCloseBottom}>
          <button data-testid="bottom-modal-child">Bottom</button>
        </Modal>
        <Modal isOpen onClose={onCloseTop}>
          <button data-testid="top-modal-child">Top</button>
        </Modal>
      </div>
    );

    // Pressing Escape should close only the most recently opened (top-most)
    // modal — the bottom modal should remain open.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCloseTop).toHaveBeenCalledTimes(1);
    expect(onCloseBottom).not.toHaveBeenCalled();
  });

  it("dismisses stacked modals one at a time, top to bottom (#1333)", () => {
    let topOpen = true;
    const onCloseBottom = jest.fn(() => {
      bottomOpen = false;
    });
    let bottomOpen = true;

    const { rerender } = render(
      <div>
        {bottomOpen && (
          <Modal isOpen onClose={onCloseBottom}>
            <button data-testid="bottom-modal-child">Bottom</button>
          </Modal>
        )}
        {topOpen && (
          <Modal isOpen onClose={() => (topOpen = false)}>
            <button data-testid="top-modal-child">Top</button>
          </Modal>
        )}
      </div>
    );

    // First Escape closes only the top modal; bottom stays open.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(topOpen).toBe(false);
    expect(bottomOpen).toBe(true);

    rerender(
      <div>
        {bottomOpen && (
          <Modal isOpen onClose={onCloseBottom}>
            <button data-testid="bottom-modal-child">Bottom</button>
          </Modal>
        )}
        {topOpen && (
          <Modal isOpen onClose={() => (topOpen = false)}>
            <button data-testid="top-modal-child">Top</button>
          </Modal>
        )}
      </div>
    );

    // Now bottom is the top-most remaining modal; Escape closes it too.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(bottomOpen).toBe(false);
  });
});
