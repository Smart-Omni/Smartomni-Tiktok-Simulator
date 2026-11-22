import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PaginatedList } from '../components/console/PaginatedList';

afterEach(cleanup);
const records = Array.from({ length: 23 }, (_, i) => `Record ${i + 1}`);
const list = (items: string[]) => <ul aria-label="Visible records">{items.map((item) => <li key={item}>{item}</li>)}</ul>;

it('pages loaded records and resets to page one when the page size changes', () => {
  render(<PaginatedList items={records} label="Requests">{list}</PaginatedList>);
  expect(within(screen.getByRole('list', { name: 'Visible records' })).getAllByRole('listitem')).toHaveLength(10);
  expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screen.getByText('Record 11')).toBeTruthy();
  expect(screen.queryByText('Record 1')).toBeNull();
  fireEvent.change(screen.getByRole('combobox', { name: 'Requests per page' }), { target: { value: '20' } });
  expect(screen.getByText('Record 1')).toBeTruthy();
  expect(screen.getByText('Page 1 of 2')).toBeTruthy();
});

it('keeps a valid page when a polled data set shrinks', () => {
  const { rerender } = render(<PaginatedList items={records} label="Requests">{list}</PaginatedList>);
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(screen.getByText('Record 23')).toBeTruthy();
  rerender(<PaginatedList items={records.slice(0, 3)} label="Requests">{list}</PaginatedList>);
  expect(screen.getByText('Record 1')).toBeTruthy();
  expect(screen.getByText('Page 1 of 1')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
});
