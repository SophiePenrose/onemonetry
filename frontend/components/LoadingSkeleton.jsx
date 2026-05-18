import React from "react";
import PropTypes from "prop-types";

export function SkeletonLine({ width, height }) {
  return (
    <div
      className="skeleton skeleton-line"
      style={{ width: width || "100%", height: height || 14 }}
    />
  );
}

SkeletonLine.propTypes = { width: PropTypes.oneOfType([PropTypes.string, PropTypes.number]), height: PropTypes.number };

export function SkeletonCard() {
  return <div className="skeleton skeleton-card" />;
}

export function TableSkeleton({ rows }) {
  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
      <SkeletonLine width="30%" height={20} />
      <div style={{ marginTop: 16 }}>
        {Array.from({ length: rows || 5 }).map((_, i) => (
          <div key={i} style={{ display: "flex", gap: 16, marginBottom: 12 }}>
            <SkeletonLine width="5%" />
            <SkeletonLine width="25%" />
            <SkeletonLine width="15%" />
            <SkeletonLine width="10%" />
            <SkeletonLine width="8%" />
            <SkeletonLine width="30%" />
          </div>
        ))}
      </div>
    </div>
  );
}

TableSkeleton.propTypes = { rows: PropTypes.number };

export function DetailSkeleton() {
  return (
    <div>
      <div style={{ background: "#fff", borderRadius: 8, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
        <SkeletonLine width="40%" height={24} />
        <div style={{ marginTop: 16 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ display: "flex", gap: 16, marginBottom: 10 }}>
              <SkeletonLine width="120px" />
              <SkeletonLine width="60%" />
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <SkeletonCard />
        <SkeletonCard />
      </div>
    </div>
  );
}
