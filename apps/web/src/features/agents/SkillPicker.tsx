import { useState, useEffect, useMemo } from 'react';
import { useIntl } from 'react-intl';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { skills as skillsApi } from '../../lib/api-client.js';
import { listSelectableSkills } from './agent-display.js';
import type { Skill } from '../../lib/api-client.js';
import { inputStyle } from '../../lib/ui.js';

interface SkillPickerProps {
  selectedSkillIds: string[];
  onChange: (skillIds: string[]) => void;
  /** Optional pre-loaded skills for the initial (no-search) view. When
   *  provided the picker skips its own default fetch and uses these instead. */
  initialSkills?: Skill[];
  /** Show a loading indicator while the parent is still fetching. Only
   *  relevant when `initialSkills` is provided by the parent. */
  loading?: boolean;
  errorMessage?: string | null;
}

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 300;

export function SkillPicker({ selectedSkillIds, onChange, initialSkills, loading = false, errorMessage = null }: SkillPickerProps) {
  const intl = useIntl();
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm.trim());
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Server-side search query — fires when user types a search term.
  // When debouncedSearch is empty, this query is disabled and we use
  // initialSkills or a default fetch instead.
  const searchQuery = useQuery({
    queryKey: ['skills', 'picker-search', debouncedSearch],
    queryFn: () => skillsApi.list({ scope: 'selectable', pageSize: PAGE_SIZE, q: debouncedSearch || undefined }),
    enabled: debouncedSearch.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  // Default fetch when no initialSkills are provided and user hasn't searched.
  const defaultQuery = useQuery({
    queryKey: ['skills', 'picker-default'],
    queryFn: () => skillsApi.list({ scope: 'selectable', pageSize: PAGE_SIZE }),
    enabled: !initialSkills && debouncedSearch.length === 0,
    staleTime: 60_000,
  });

  const isSearching = debouncedSearch.length > 0;
  const selected = new Set(selectedSkillIds);

  const displaySkills = useMemo(() => {
    if (isSearching) {
      return listSelectableSkills(searchQuery.data?.skills ?? []);
    }
    if (initialSkills) {
      return listSelectableSkills(initialSkills);
    }
    return listSelectableSkills(defaultQuery.data?.skills ?? []);
  }, [isSearching, searchQuery.data, initialSkills, defaultQuery.data]);

  const isLoading = loading
    || (isSearching && searchQuery.isLoading)
    || (!initialSkills && !isSearching && defaultQuery.isLoading);

  if (isLoading && displaySkills.length === 0) {
    return <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.skillPicker.loading' })}</div>;
  }

  if (errorMessage) {
    return <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>{errorMessage}</div>;
  }

  if (!isSearching && displaySkills.length === 0) {
    return <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.skillPicker.empty' })}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <input
        type="text"
        placeholder={intl.formatMessage({ id: 'agents.skillPicker.searchPlaceholder', defaultMessage: 'Search skills\u2026' })}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        style={{ ...inputStyle, padding: '6px 10px', fontSize: '0.8125rem', borderRadius: '6px' }}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          maxHeight: displaySkills.length > 4 ? '280px' : undefined,
          overflowY: displaySkills.length > 4 ? 'auto' : undefined,
          paddingRight: displaySkills.length > 4 ? '4px' : undefined,
        }}
      >
        {isSearching && searchQuery.isFetching && displaySkills.length === 0 ? (
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', padding: '8px 0' }}>
            {intl.formatMessage({ id: 'agents.skillPicker.searching', defaultMessage: 'Searching\u2026' })}
          </div>
        ) : displaySkills.length === 0 ? (
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', padding: '8px 0' }}>
            {intl.formatMessage({ id: 'agents.skillPicker.noResults', defaultMessage: 'No skills match your search.' })}
          </div>
        ) : (
          displaySkills.map((skill) => {
            const isSelected = selected.has(skill.id);

            return (
              <label
                key={skill.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '10px 12px',
                  border: `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  background: isSelected ? 'var(--color-accent-subtle, rgba(99,102,241,0.08))' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {
                    onChange(isSelected ? selectedSkillIds.filter((skillId) => skillId !== skill.id) : [...selectedSkillIds, skill.id]);
                  }}
                  style={{ marginTop: '3px', flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontWeight: '400', fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>{skill.name}</div>
                  <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', fontFamily: 'monospace' }}>{skill.slug}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '2px', lineHeight: '1.45' }}>
                    {skill.description.length > 50 ? `${skill.description.slice(0, 50)}\u2026` : skill.description}
                  </div>
                </div>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
