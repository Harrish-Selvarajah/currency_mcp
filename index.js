#!/usr/bin/env node

/**
 * MCP Currency Exchange Server
 * Fetches Sri Lankan exchange rates from numbers.lk and provides conversion tools
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as cheerio from 'cheerio';

class CurrencyExchangeServer {
  constructor() {
    this.server = new Server(
      {
        name: 'currency-exchange-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_exchange_rates',
          description: 'Get current exchange rates from Sri Lankan banks',
          inputSchema: {
            type: 'object',
            properties: {
              currency: {
                type: 'string',
                description: 'Currency code (e.g., USD, EUR, GBP) - optional, returns all if not specified',
                default: 'ALL'
              }
            },
          },
        },
        {
          name: 'convert_currency',
          description: 'Convert amount between currencies using latest rates',
          inputSchema: {
            type: 'object',
            properties: {
              amount: {
                type: 'number',
                description: 'Amount to convert',
              },
              from_currency: {
                type: 'string',
                description: 'Source currency code (e.g., USD, EUR, LKR)',
              },
              to_currency: {
                type: 'string',
                description: 'Target currency code (e.g., USD, EUR, LKR)',
              },
              rate_type: {
                type: 'string',
                description: 'Rate type: buying or selling',
                enum: ['buying', 'selling'],
                default: 'selling'
              }
            },
            required: ['amount', 'from_currency', 'to_currency'],
          },
        },
        {
          name: 'get_currency_trend',
          description: 'Get historical trend data for a currency (simulated)',
          inputSchema: {
            type: 'object',
            properties: {
              currency: {
                type: 'string',
                description: 'Currency code (e.g., USD, EUR, GBP)',
              },
              days: {
                type: 'number',
                description: 'Number of days to look back',
                default: 7
              }
            },
            required: ['currency'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'get_exchange_rates':
          return await this.getExchangeRates(request.params.arguments);
        case 'convert_currency':
          return await this.convertCurrency(request.params.arguments);
        case 'get_currency_trend':
          return await this.getCurrencyTrend(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  async fetchExchangeRates() {
    try {
      // Try to fetch from numbers.lk first
      const response = await axios.get('https://tools.numbers.lk/exrates', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 10000
      });

      const $ = cheerio.load(response.data);
      const rates = {};

      // Try to extract rates from the page
      // This is a simplified extraction - you may need to adjust based on actual page structure
      $('table tr').each((i, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 3) {
          const currency = $(cells[0]).text().trim();
          const buying = $(cells[1]).text().trim();
          const selling = $(cells[2]).text().trim();

          if (currency && buying && selling) {
            rates[currency] = {
              buying: parseFloat(buying) || 0,
              selling: parseFloat(selling) || 0,
              source: 'numbers.lk',
              timestamp: new Date().toISOString()
            };
          }
        }
      });

      // If no rates found from scraping, use fallback API
      if (Object.keys(rates).length === 0) {
        return await this.getFallbackRates();
      }

      return rates;
    } catch (error) {
      console.error('Error fetching from numbers.lk:', error.message);
      return await this.getFallbackRates();
    }
  }

  async getFallbackRates() {
    console.log('Fetching fallback rates in the mcp server we created');
    try {
      // Use a free exchange rate API as fallback
      const response = await axios.get('https://api.exchangerate-api.com/v4/latest/LKR');
      const data = response.data;

      const rates = {};

      // Convert the rates to our format
      Object.keys(data.rates).forEach(currency => {
        if (['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'SGD', 'INR'].includes(currency)) {
          const rate = 1 / data.rates[currency]; // Convert from LKR base to currency base
          rates[currency] = {
            buying: rate * 0.98, // Simulate buying rate (slightly lower)
            selling: rate * 1.02, // Simulate selling rate (slightly higher)
            source: 'exchangerate-api.com',
            timestamp: new Date().toISOString()
          };
        }
      });

      // Add LKR as base
      rates['LKR'] = {
        buying: 1,
        selling: 1,
        source: 'base',
        timestamp: new Date().toISOString()
      };

      return rates;
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch exchange rates: ${error.message}`
      );
    }
  }

  async getExchangeRates(args) {
    try {
      const rates = await this.fetchExchangeRates();
      const currency = args?.currency?.toUpperCase();

      if (currency && currency !== 'ALL') {
        if (rates[currency]) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  currency: currency,
                  rate: rates[currency],
                  last_updated: new Date().toISOString()
                }, null, 2)
              }
            ]
          };
        } else {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Currency ${currency} not found`
          );
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rates: rates,
              last_updated: new Date().toISOString(),
              total_currencies: Object.keys(rates).length
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get exchange rates: ${error.message}`
      );
    }
  }

  async convertCurrency(args) {
    try {
      const { amount, from_currency, to_currency, rate_type = 'selling' } = args;

      if (!amount || !from_currency || !to_currency) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Missing required parameters: amount, from_currency, to_currency'
        );
      }

      const rates = await this.fetchExchangeRates();
      const fromCurrency = from_currency.toUpperCase();
      const toCurrency = to_currency.toUpperCase();

      let convertedAmount = 0;
      let conversionRate = 0;

      if (fromCurrency === 'LKR') {
        // Converting from LKR to foreign currency
        if (rates[toCurrency]) {
          conversionRate = 1 / rates[toCurrency][rate_type];
          convertedAmount = amount * conversionRate;
        } else {
          throw new McpError(ErrorCode.InvalidParams, `Currency ${toCurrency} not supported`);
        }
      } else if (toCurrency === 'LKR') {
        // Converting from foreign currency to LKR
        if (rates[fromCurrency]) {
          conversionRate = rates[fromCurrency][rate_type];
          convertedAmount = amount * conversionRate;
        } else {
          throw new McpError(ErrorCode.InvalidParams, `Currency ${fromCurrency} not supported`);
        }
      } else {
        // Converting between two foreign currencies via LKR
        if (rates[fromCurrency] && rates[toCurrency]) {
          const toLkr = amount * rates[fromCurrency][rate_type];
          conversionRate = toLkr / rates[toCurrency][rate_type];
          convertedAmount = toLkr / rates[toCurrency][rate_type];
        } else {
          throw new McpError(ErrorCode.InvalidParams, 'One or both currencies not supported');
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              original_amount: amount,
              from_currency: fromCurrency,
              to_currency: toCurrency,
              converted_amount: Math.round(convertedAmount * 100) / 100,
              conversion_rate: Math.round(conversionRate * 10000) / 10000,
              rate_type: rate_type,
              timestamp: new Date().toISOString()
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to convert currency: ${error.message}`
      );
    }
  }

  async getCurrencyTrend(args) {
    try {
      const { currency, days = 7 } = args;
      const targetCurrency = currency.toUpperCase();

      // This is a simplified trend simulation
      // In a real implementation, you'd fetch historical data
      const currentRates = await this.fetchExchangeRates();

      if (!currentRates[targetCurrency]) {
        throw new McpError(ErrorCode.InvalidParams, `Currency ${targetCurrency} not supported`);
      }

      const trend = [];
      const baseRate = currentRates[targetCurrency].selling;

      for (let i = days - 1; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);

        // Simulate some variation (±2%)
        const variation = (Math.random() - 0.5) * 0.04;
        const rate = baseRate * (1 + variation);

        trend.push({
          date: date.toISOString().split('T')[0],
          rate: Math.round(rate * 100) / 100,
          change: i === days - 1 ? 0 : Math.round(((rate - baseRate) / baseRate) * 10000) / 100
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              currency: targetCurrency,
              period_days: days,
              trend: trend,
              current_rate: baseRate,
              generated_at: new Date().toISOString()
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get currency trend: ${error.message}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Currency Exchange MCP server running on stdio');
  }
}

const server = new CurrencyExchangeServer();
server.run().catch(console.error);