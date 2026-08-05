import { test, expect } from '@playwright/test';
import { baseURL } from '../playwright.config';

test.describe('Chorus shell', () => {
  test('loads the Traces view and navigates between views', async ({ page }) => {
    await page.goto(baseURL, { waitUntil: 'networkidle' });

    await expect(page).toHaveURL(/\/traces$/);
    await expect(page.getByRole('heading', { name: 'Traces' })).toBeVisible();

    await page.getByRole('link', { name: /Monitor/ }).click();
    await expect(page.getByRole('heading', { name: 'Monitor' })).toBeVisible();

    await page.getByRole('link', { name: /Evals/ }).click();
    await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible();
  });
});
