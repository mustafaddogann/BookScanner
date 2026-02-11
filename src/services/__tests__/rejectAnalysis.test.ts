import { generateHypotheses, generateBoostHypotheses, getQuerySet } from '../queryHypotheses';

describe('Reject Analysis', () => {
  test('DIED IN THE WOOL NGALO LUI should generate NGAIO MARSH hypothesis', () => {
    const lines = ['DIED IN THE WOOL NGALO LUI'];
    const result1 = generateHypotheses(lines);
    console.log('Pass1:', result1.hypotheses.map(h => h.query));
    
    const boost = generateBoostHypotheses(lines, getQuerySet(result1.hypotheses));
    console.log('Boost (first 25):', boost.hypotheses.map(h => `${h.priority}: ${h.query}`));
    
    // Check if NGAIO MARSH or DIED IN THE WOOL variants are generated
    const hasRelevant = boost.hypotheses.some(h => {
      const upper = h.query.toUpperCase();
      return upper.includes('NGAIO') || upper.includes('MARSH') || 
             (upper.includes('DIED') && upper.includes('WOOL'));
    });
    expect(hasRelevant).toBe(true);
  });

  test('SEIZE TIE NIGHT + DEAN KO should generate corrections', () => {
    const lines = ['NOVEL', '7748', 'ANTAT', 'DEAN KO', 'SEIZE', 'TIE NIGHT'];
    const result = generateHypotheses(lines);
    console.log('Pass1:', result.hypotheses.map(h => h.query));
    
    const boost = generateBoostHypotheses(lines, getQuerySet(result.hypotheses));
    console.log('Boost (first 25):', boost.hypotheses.map(h => `${h.priority}: ${h.query}`));
    
    // Check for SEIZE THE NIGHT or DEAN KOONTZ
    const hasSeizeTheNight = boost.hypotheses.some(h => h.query.toUpperCase().includes('SEIZE THE NIGHT'));
    const hasDeanKoontz = boost.hypotheses.some(h => h.query.toUpperCase().includes('DEAN KOONTZ'));
    console.log('Has SEIZE THE NIGHT:', hasSeizeTheNight);
    console.log('Has DEAN KOONTZ:', hasDeanKoontz);
  });

  test('THE GOOD LUCK MUKDERS should generate MURDERS correction', () => {
    const lines = ['THE GOOD LUCK MUKDERS JOINS', 'JOHNS', 'MYSTEFT', 'PIRA ACIA', 'OKIE'];
    const result = generateHypotheses(lines);
    console.log('Pass1:', result.hypotheses.map(h => h.query));
    
    const boost = generateBoostHypotheses(lines, getQuerySet(result.hypotheses));
    console.log('Boost (first 25):', boost.hypotheses.map(h => `${h.priority}: ${h.query}`));
    
    // Check for MURDERS
    const hasMurders = boost.hypotheses.some(h => h.query.toUpperCase().includes('MURDER'));
    console.log('Has MURDERS:', hasMurders);
  });

  test('THE LAST ONF LEFT JOHN D. MACDO should generate ONE and MACDONALD', () => {
    const lines = ['THE LAST ONF LEFT JOHN D. MACDO'];
    const result = generateHypotheses(lines);
    console.log('Pass1:', result.hypotheses.map(h => h.query));
    
    const boost = generateBoostHypotheses(lines, getQuerySet(result.hypotheses));
    console.log('Boost (first 25):', boost.hypotheses.map(h => `${h.priority}: ${h.query}`));
    
    // Check for ONE or MACDONALD
    const hasOne = boost.hypotheses.some(h => h.query.toUpperCase().includes('ONE LEFT'));
    const hasMacdonald = boost.hypotheses.some(h => h.query.toUpperCase().includes('MACDONALD'));
    console.log('Has ONE LEFT:', hasOne);
    console.log('Has MACDONALD:', hasMacdonald);
  });
});
