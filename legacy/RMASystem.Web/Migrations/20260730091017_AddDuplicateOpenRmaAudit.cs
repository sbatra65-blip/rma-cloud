using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class AddDuplicateOpenRmaAudit : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "DuplicateOpenAt",
                table: "RMATickets",
                type: "datetime",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DuplicateOpenBy",
                table: "RMATickets",
                type: "nvarchar(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DuplicateOpenReason",
                table: "RMATickets",
                type: "nvarchar(max)",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "DuplicateOpenAt",
                table: "RMATickets");

            migrationBuilder.DropColumn(
                name: "DuplicateOpenBy",
                table: "RMATickets");

            migrationBuilder.DropColumn(
                name: "DuplicateOpenReason",
                table: "RMATickets");
        }
    }
}
